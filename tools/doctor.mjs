import path from 'node:path';
import {execFile} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

export const requiredFilters = Object.freeze(['color', 'drawbox', 'amix', 'ebur128', 'aformat', 'aresample']);
export const requiredEncoders = Object.freeze(['libx264', 'alac', 'aac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'rawvideo']);
const maximumProfileBytes = 1024 * 1024;
const help = `W自动配乐：只读环境检查

用法：node tools/doctor.mjs [--profile ABSOLUTE_JSON] [--json] [--help]

默认检查 Node 24.19.0+（24.x）、FFmpeg、FFprobe 和离线演示所需滤镜/编码器。
Python 为可选依赖，不启动 Python 命令，不影响离线演示。
--profile 仅检查显式指定的本地部署 JSON（最大 1 MiB）及其已有绑定。
不读取默认私有配置，不安装、不下载、不调用模型、不注册影片、不生成授权或回执。
通过仅表示离线依赖可用；不是完整自动模式、艺术听感或生产使用批准。
`;

// Never run a shell or expose child error messages/output in the public report.
export function probeCommand(command, args, {timeoutMs = 10000, maxOutputBytes = 1024 * 1024} = {}) {
  return new Promise(resolve => {
    const environment = {...process.env};
    for (const key of Object.keys(environment)) {
      if (/^(?:FFREPORT|AV_LOG_FORCE_COLOR|NODE_OPTIONS)$/i.test(key)
        || /^(?:SDR_|OPENAI_|ANTHROPIC_|GEMINI_)/i.test(key)
        || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|PASSWORD)$/i.test(key)) delete environment[key];
    }
    execFile(command, args, {shell: false, windowsHide: true, encoding: 'utf8',
      env: environment, timeout: timeoutMs, maxBuffer: maxOutputBytes}, (error, stdout) => {
      if (!error) return resolve({ok: true, stdout});
      const reason = error.code === 'ENOENT' ? 'missing_command'
        : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit'
          : error.killed ? 'timeout' : 'command_failed';
      resolve({ok: false, reason});
    });
  });
}

function supportedNode(version) {
  const match = typeof version === 'string' && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return Boolean(match && match[1] === '24' && Number(match[2]) >= 19
    && match.slice(1).every(item => Number.isSafeInteger(Number(item))));
}

function listedNames(output) {
  return new Set(String(output ?? '').split(/\r?\n/).flatMap(line => {
    const match = /^\s*[A-Z.]{2,6}\s+([A-Za-z0-9_]+)\s+/.exec(line);
    return match ? [match[1]] : [];
  }));
}

const hints = {
  missing_command: '请安装包含所需组件的 FFmpeg，并将 ffmpeg、ffprobe 加入 PATH 后重新打开终端。工具不会自动安装。',
  timeout: '命令检查超时；请在终端手动确认 FFmpeg 能正常启动后重试。',
  output_limit: '命令输出超过安全上限；请检查 PATH 指向的是标准 FFmpeg 程序。',
  command_failed: '命令未正常运行；请检查本地 FFmpeg 安装和执行权限后重试。',
};

/** Read-only dependency checks. The injectable probe keeps OS failures reproducible in tests. */
export async function runDoctor({nodeVersion = process.version, profilePath, probe = probeCommand} = {}) {
  const checks = [];
  const append = (id, status, message, action, detail) => {
    const row = {id, status, message};
    if (action) row.action = action;
    if (detail) row.detail = detail;
    checks.push(row);
  };
  append('node', supportedNode(nodeVersion) ? 'passed' : 'failed',
    supportedNode(nodeVersion) ? 'Node 版本符合要求' : 'Node 版本不符合要求',
    supportedNode(nodeVersion) ? null : '请使用正式版 Node 24.19.0 或更高的 24.x 版本，然后重新运行。');

  async function inspect(id, command, args, consume) {
    let result;
    try { result = await probe(command, args); }
    catch { result = {ok: false, reason: 'command_failed'}; }
    if (result?.ok !== true) {
      const reason = Object.hasOwn(hints, result?.reason) ? result.reason : 'command_failed';
      append(id, 'failed', `${id} 检查失败`, hints[reason], {reason});
      return false;
    }
    consume(String(result.stdout ?? ''));
    return true;
  }
  for (const command of ['ffmpeg', 'ffprobe']) {
    await inspect(command, command, ['-version'], output => {
      const match = new RegExp(`^${command} version (?:n?(\\d+\\.\\d+(?:\\.\\d+)?)(?=[\\s.+_-]|$)|N-\\d+-g[a-f0-9]+(?=[\\s-]|$))`, 'm').exec(output);
      const version = match ? match[1] ?? 'development' : null;
      append(command, version ? 'passed' : 'failed', version ? `${command} 可启动` : `${command} 版本输出无法识别`,
        version ? null : '请检查 PATH 指向的是标准 FFmpeg/FFprobe 程序。', version ? {version} : undefined);
    });
  }
  if (checks.find(row => row.id === 'ffmpeg')?.status === 'passed') {
    for (const [kind, required] of [['filters', requiredFilters], ['encoders', requiredEncoders]]) {
      await inspect(`ffmpeg_${kind}`, 'ffmpeg', ['-hide_banner', `-${kind}`], output => {
        const names = listedNames(output), missing = required.filter(name => !names.has(name));
        append(`ffmpeg_${kind}`, missing.length ? 'failed' : 'passed',
          missing.length ? `FFmpeg 缺少所需${kind === 'filters' ? '滤镜' : '编码器'}` : `FFmpeg ${kind} 符合离线演示要求`,
          missing.length ? '请改用包含这些组件的 FFmpeg 构建，并重新运行检查；工具不会自动安装。' : null,
          {required: [...required], missing});
      });
    }
  }
  append('python', 'optional', 'Python 为可选依赖，本次未启动检查，不影响离线演示',
    '完整自动流程的 Python、模型、素材和授权需另行配置；不要把此检查视为自动模式已就绪。');

  if (profilePath !== undefined) {
    if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) {
      append('deployment_profile', 'failed', '部署配置必须使用绝对路径', '请通过 --profile 指定本地 JSON 的绝对路径。');
    } else {
      try {
        const info = await stat(profilePath);
        if (!info.isFile() || info.size > maximumProfileBytes) {
          append('deployment_profile', 'failed', '部署配置必须是最大 1 MiB 的普通文件', '请选择本地部署 JSON，不要选择目录或超大文件。');
        } else {
          const {loadUploadDeploymentProfile} = await import('../scripts/compose_uploaded_episode.mjs');
          await loadUploadDeploymentProfile(profilePath);
          append('deployment_profile', 'passed', '部署配置的本地结构与已有绑定通过检查',
            '这不验证全部运行时依赖、模型、素材资格、账户或完整自动模式；不会创建授权或审批记录。');
        }
      } catch (error) {
        const reason = error?.code === 'ENOENT' ? 'profile_or_binding_missing'
          : error instanceof SyntaxError ? 'invalid_json' : 'profile_validation_failed';
        append('deployment_profile', 'failed', '部署配置或其绑定未通过只读校验',
          '请确认 JSON 存在、格式正确，并按部署文档补齐真实的已有绑定；不要编造授权或回执。', {reason});
      }
    }
  } else {
    append('deployment_profile', 'optional', '未提供部署配置；离线演示无需私人配置',
      '需要检查已有部署配置时，再显式传入 --profile ABSOLUTE_JSON。');
  }
  const failed = checks.filter(row => row.status === 'failed');
  return {schema_version: 1, ok: failed.length === 0,
    offline_ready: failed.every(row => row.id === 'deployment_profile'),
    automatic_readiness: 'unverified', profile_checked: profilePath !== undefined,
    profile_check_scope: 'local_structure_and_existing_bindings_only',
    automatic_checks: ['runtime_dependencies', 'licensed_assets', 'account_configuration',
      'model_qualification', 'real_episode_processing', 'artistic_review']
      .map(id => ({id, status: 'not_checked'})),
    scope: 'read_only_offline_dependencies_and_optional_local_profile_not_production_approval', checks};
}

function formatReport(report) {
  const lines = ['W自动配乐：只读环境检查',
    `离线依赖：${report.offline_ready ? '已就绪（未执行演示）' : '尚未就绪'}`,
    '完整自动模式：未验证'];
  for (const row of report.checks) {
    lines.push(`[${row.status}] ${row.message}`);
    if (row.detail?.missing?.length) lines.push(`  缺少：${row.detail.missing.join(', ')}`);
    if (row.action) lines.push(`  建议：${row.action}`);
  }
  return lines.join('\n') + '\n';
}

export async function runDoctorCli(argv, {write = value => process.stdout.write(value), ...options} = {}) {
  if (argv.includes('--help')) { write(help); return 0; }
  let values;
  try {
    ({values} = parseArgs({args: argv, options: {profile: {type: 'string'}, json: {type: 'boolean'}},
      strict: true, allowPositionals: false}));
    if (values.profile !== undefined && (!values.profile || !path.isAbsolute(values.profile))) throw Error();
    if (argv.filter(value => value === '--profile' || value.startsWith('--profile=')).length > 1) throw Error();
  } catch {
    const failure = {schema_version: 1, ok: false, offline_ready: false, automatic_readiness: 'unverified',
      checks: [{id: 'arguments', status: 'failed', message: '参数无效；使用 --help 查看用法。'}]};
    write(argv.includes('--json') ? JSON.stringify(failure, null, 2) + '\n' : formatReport(failure));
    return 1;
  }
  const report = await runDoctor({...options, profilePath: values.profile});
  write(values.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runDoctorCli(process.argv.slice(2)); }
  catch { process.stderr.write('环境检查未完成；请检查本地命令和参数后重试。\n'); process.exitCode = 1; }
}

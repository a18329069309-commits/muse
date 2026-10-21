// Explicit retrieval ordering only: never approves sound, words or dramatic use.
export const independentPackRankingRevision = 'positive-relevance-family-mmr-v1';
export function validateIndependentPackRankingPolicy(value) {
  if (value === undefined || value === null) return null;
  const fields = ['revision', 'relevance_weight', 'minimum_similarity', 'history_penalty_weight',
    'history_penalty_cap', 'preference_penalty_weight', 'distinct_family_prefix'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key)) || value.revision !== independentPackRankingRevision)
    throw Error('independent_clap_ranking_policy_invalid');
  const policy = { relevance_weight: 0.85, minimum_similarity: 0, history_penalty_weight: 0.02,
    history_penalty_cap: 0.06, preference_penalty_weight: 0.005, distinct_family_prefix: 2, ...value };
  for (const key of ['relevance_weight', 'minimum_similarity', 'history_penalty_weight',
    'history_penalty_cap', 'preference_penalty_weight'])
    if (!Number.isFinite(policy[key])) throw Error('independent_clap_ranking_policy_invalid');
  if (policy.relevance_weight < 0.5 || policy.relevance_weight > 1
    || policy.minimum_similarity < 0 || policy.minimum_similarity >= 1
    || policy.history_penalty_weight < 0 || policy.history_penalty_weight > 0.1
    || policy.history_penalty_cap < 0 || policy.history_penalty_cap > 0.1
    || policy.preference_penalty_weight < 0 || policy.preference_penalty_weight > 0.02
    || !Number.isSafeInteger(policy.distinct_family_prefix)
    || policy.distinct_family_prefix < 1 || policy.distinct_family_prefix > 5)
    throw Error('independent_clap_ranking_policy_invalid');
  return policy;
}

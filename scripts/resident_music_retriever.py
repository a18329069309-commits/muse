"""Resident offline CLAP worker: JSONL stdin requests, JSONL stdout responses."""
import argparse
import sys

from clap_segment_features import ResidentRetriever, serve_requests
from gpu_single_slot import gpu_slot_guard, slot_binding_from_args, add_slot_arguments


@gpu_slot_guard(lambda args: args.device, slot_binding_from_args)
def serve(args):
    # Retain the slot for the complete loaded-model/JSONL worker lifetime.
    serve_requests(ResidentRetriever(args.index,args.weights,args.device),sys.stdin)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index',required=True)
    parser.add_argument('--weights',required=True)
    parser.add_argument('--device',choices=['cpu','cuda'],default='cpu')
    add_slot_arguments(parser)
    args=parser.parse_args()
    serve(args)


if __name__=='__main__':main()

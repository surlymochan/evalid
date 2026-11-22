#!/usr/bin/env python3
"""B2.status.read — Read and return status.json for a change."""
import sys, os, json, argparse
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from common import load_status

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--project-root', default='.')
    p.add_argument('--change-id', required=True)
    args = p.parse_args()
    status = load_status(args.project_root, args.change_id)
    # Compact separators: the full status value is unchanged for parsers,
    # but this echo lands in the caller's context on every read (M18 #224
    # lever A — B2b/B3 already print compact summaries for the same reason).
    print(json.dumps(status, separators=(",", ":")))

if __name__ == '__main__':
    main()

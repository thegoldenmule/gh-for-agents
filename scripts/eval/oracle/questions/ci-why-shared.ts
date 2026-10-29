// The expert's first look at a PR's CI, shared by the three ci-why variants: bucket counts, then one TSV row
// per failing or pending check (name and link, which carries the run and job ids).
export const EXPERT_CHECKS_JQ =
  '(group_by(.bucket) | map({(.[0].bucket): length}) | add), (.[] | select(.bucket == "fail" or .bucket == "pending") | [.bucket, .name, .link] | @tsv)';

/** `gh pr checks <n>` with the expert's --json/--jq. */
export const expertChecks = (pr: number): string =>
  `gh pr checks ${pr} --json name,bucket,link --jq '${EXPERT_CHECKS_JQ}'`;

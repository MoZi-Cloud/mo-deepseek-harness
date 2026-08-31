/**
 * Benign corpus: project facts that must produce zero findings — not even
 * caution. These are the shapes self-evolution memory is supposed to hold,
 * so the corpus doubles as the false-positive budget for the pattern set.
 * @module
 */

/** Benign corpus entries, keyed for assertion messages. */
export const BENIGN_CASES: readonly { readonly name: string; readonly text: string }[] = [
  {
    name: 'build-flow',
    text: 'Release flow: run pnpm build in apps/web, then the release script tags the commit.',
  },
  {
    name: 'database',
    text: 'Postgres runs on db.internal:5432; migration files live under packages/db/migrations.',
  },
  {
    name: 'staging-reboot',
    text: 'The staging server reboots nightly at 02:00 UTC; the test suite must pass before merge.',
  },
  {
    name: 'code-owners',
    text: 'Review owners: backend work goes to team-core, frontend work to team-web.',
  },
  {
    name: 'exports',
    text: 'The report generator writes CSV exports to ./exports and the uploader moves them into the S3 release bucket.',
  },
  {
    name: 'ports',
    text: 'Local development listens on port 3000; continuous integration uses 4200.',
  },
  {
    name: 'auth',
    text: 'Auth middleware validates tokens against the JWKS document at /certs on the identity service.',
  },
  {
    name: 'deploy-user',
    text: 'Staging deploys go over ssh as deploy@staging with the repo checked out at /srv/app.',
  },
  {
    name: 'analytics',
    text: 'Analytics events reach the warehouse table every 15 minutes through the scheduled loader.',
  },
  {
    name: 'tooling',
    text: 'Use pnpm rather than npm in this repository; Node 22 is the minimum supported version.',
  },
  {
    name: 'code-block',
    text: 'The quickstart in the readme is:\n```sh\npnpm install && pnpm build\n```\nFollow it before editing source files.',
  },
  {
    name: 'descriptive-verbs',
    text: 'The retry helper ignores transient failures; earlier guidance about timeouts remains cached in this document.',
  },
]

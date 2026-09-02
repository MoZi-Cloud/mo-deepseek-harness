# RC5.5.5 附件 P5 — 自我进化质量评测与分级 rollout authorization（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P3、P4；无独立 runtime package；日期：2026-09-02。
>
> P5 是conservative L1的准入条件，不是可选报表。CI keyless层验证protocol/runner/scorer/gate；发布准入层按configured named profile解析出的exact `ReviewAuthorizationScopeDigest`受控评测。每个scope分别决定最高`conservative-draft|conservative-auto` level与capabilities；authorization不改运行配置、不提升shadow plan，也不证明任一尚未出现的未来skill proposal正确。

## 1. 代码与资产面

```text
<session-review-package>/evals/  # P5 开工时落到 session-review package；当前尚未创建
  manifest.v2.json              # nine strata/split/case/named review scopes/policy/threshold
  fixtures/<stratum>/*.json     # durable input + oracle，不含凭据
  recorded/<case>/<run>.json    # keyless candidate/baseline 记录
scripts/self-evolution-eval/
  types.ts                      # manifest/result/score/gate types
  manifest.ts                   # schema + digest + split guard
  fixtures.ts                   # load/validate/redact
  replay.ts                     # keyless protocol replay
  eval-domain.ts                # disposable composition + production-policy evaluation permit
  controlled-run.ts             # owner-controlled real-model run
  score.ts                      # per-case pure scoring
  aggregate.ts                  # stratum/confidence/non-inferiority
  gate.ts                       # hard + statistical decisions
  report.ts                     # machine JSON + human Markdown
scripts/verify-self-evolution-quality.ts
```

Repository scripts 增加 `test:self-evolution-eval`（keyless，CI）与 `verify:self-evolution-rollout`（受控准入，需显式 model credentials）。两者都从 source plane 运行或都声明 build 前置，不得一部分读 `src` 、一部分偷读 stale `lib` 。

## 2. corpus 与 oracle

Manifest v2固定九个stratum：`user-correction`、`verified-success`、`failure-recovery`、`changed-method-recovery`、`unresolved-failure`、`transient-environment`、`no-learning-signal`、`repeated-skill-reuse`、`skill-consolidation`。每层有calibration与held-out。发布gate以独立held-out case为抽样单位：各层至少30，且`user-correction`至少35、`no-learning-signal`至少73、`repeated-skill-reuse`至少35、`changed-method-recovery`至少35、`skill-consolidation`至少35，故v2总数至少333。后两层的35不能降为30：前者要求错误promotion rate的95% Wilson upper bound≤0.10，后者要求preservation/non-merge的95% Wilson lower bound≥0.90；30个全成功或零错误样本都不可达。一个case的provider repeats不是独立case。任一层不足为`insufficient_evidence`，不可跨层、跨scope或用repeat抵消。RC5.5.4的七层corpus属eval protocol v1；strata、threshold、authorization capability或permit语义变更后，v1 report/artifact不得被v2 loader接受。

以上333个held-out下限对每个待授权`ReviewAuthorizationScopeDigest`独立成立。Scope集合只能来自manifest列出的named `ReviewExecutionProfileId`及其解析字段，不按historical source route展开。相同case可在多个scope运行独立报告，但A不能补B。Manifest为每个scope固定review provider、resolved call config、adapter execution profile digest、canonical isolated `EpochHeader`、output schema与policy/learning/op/eval versions；实际运行从P3 helper重算digest，不接受手填digest。

每个 fixture 包含不可变 `caseId/stratum/inputDigest/oracleDigest`、durable session events/resource base/rollout policy，以及仅 scorer 读取的 oracle：允许/禁止的 memory facts、必须保留/排除的步骤、skill 目标、scope、预期 abstain、重复任务成功与弯路计数。runner 只把 input 送给 baseline/candidate，不把 oracle/threshold/split 暴露给 planner。

held-out 的 case 列表、input digest 与 oracle digest 在开发前锁定；为修 prompt/policy 查看或更改 held-out oracle 后，原 held-out 自动降为 calibration，必须补新的未见 case。阈值是 manifest protocol version 的一部分，变更必须新版本与 Agent Note，不能为某次运行临时降低。

## 3. 开发拓扑

| 顺序 | 节点 | 只可调用 |
|---:|---|---|
| P5-D01 | types/schemas + Wilson/evaluation permit id helpers | zod、crypto、P2/P3/P4 public types |
| P5-D02 | `loadEvalManifest` schema parse | D01 |
| P5-D03 | `verifyFixtureDigests` | D02 |
| P5-D04 | `validateSplitIsolation` + per-scope sample reachability | D01–D03 |
| P5-D05 | `loadFixture` | D02–D04 |
| P5-D06 | `redactOracleForRunner` | D05 |
| P5-D07 | `createEvalComposition` | D06、P1–P4 public Services/loaders/test harness |
| P5-D08 | `replayProtocolCase` | D06–D07 |
| P5-D09 | `applyCandidateWithProductionPolicyInEvalDomain` | D01、D07–D08、P1/P2/P3/P4 public policy/Service APIs |
| P5-D10 | `runControlledCase` | D06–D09、shipped shadow profile、locked review execution scope |
| P5-D11 | `scoreCase` | D01、D05、canonical comparison helpers |
| P5-D12 | `confidenceBounds/pairedNonInferiority` → `aggregateByStratum` | D11 |
| P5-D13 | `evaluateQualityGate` | D02、D04、D12 |
| P5-D14 | `buildQualityReport` | D13 |
| P5-D15 | `buildRolloutAuthorization` | D13–D14 |
| P5-D16 | top-level scripts/package commands | D02–D15 |

Scorer不调runner，gate不重算case score，report不改gate decision。Controlled runner学习阶段只运行shadow，并通过P3 named profile/E01/D07/D19取得actual scope与attestation；mismatch是hard breach。为测量未来auto level，D09在一次性eval domain调用production共用的P2 promotion policy和内部activation transaction。因为authorization是评测输出，D01生成domain-separated `EvaluationPromotionPermit`仅替代“已签authorization”事实；D07再为当前fixture root创建进程内、不可序列化的`EvaluationPromotionAuthority`与`EvaluationConsolidationAuthority`。Permit与promotion authority同时验证后，eval-only adapter才能进入与production共用的private activation transaction；consolidation authority只替代待签`skill-consolidation` capability。Owner、evidence、unresolved、scan/quota、pin/conflict、exact base、CAS、activation lineage、planner attestation与Provider read一项也不能绕过。Production P2/P4公开方法不接受eval permit/authority；它们不可序列化、不进入runtime parser或rollout artifact。

## 4. manifest、runner 与 scorer

#### `minimumPassableWilsonCases(threshold,confidence): number`
- 拓扑：P5-D01。
- 职责：只接受 `0<threshold<1` 与 protocol-pinned `confidence=0.95`；用标准正态 95% 双侧临界值和全成功 Wilson lower bound 反推最小独立 case 数，向上取整。它是 manifest 可达性校验，不读取运行结果；confidence/公式变化必须 bump eval protocol version。
- 验收：`wilson-perfect-minimum-point-nine-is-35`、`wilson-perfect-minimum-point-nine-five-is-73`、`one-less-case-is-mathematically-unpassable`、`unsupported-confidence-fails-loud`。

#### `deriveEvaluationPromotionPermitId(caseId,repeatIndex,scopeDigest,ref,revisionDigest,policyVersion): EvaluationPromotionPermitId`
- 拓扑：P5-D01。
- 职责：domain-separated deterministic hash；输入来自validated fixture/run、exact scope/revision与policy version，模型不能提供。Crash replay同id，不同case/repeat/scope/revision/policy不碰撞；只在disposable eval ledger有效，production permit parser拒绝该brand。
- 验收：`eval-promotion-permit-id-replay-stable`、`eval-permit-binds-case-repeat-scope-revision-policy`、`eval-permit-not-model-supplied`、`eval-permit-cannot-parse-as-rollout-permit`（T91）。

#### `deriveEvaluationConsolidationPermitId(caseId,repeatIndex,scopeDigest,clusterId,planDigest,evalProtocolVersion): EvaluationConsolidationPermitId`
- 拓扑：P5-D01。
- 职责：domain-separated deterministic hash；只从validated case/repeat、exact named scope、P4 cluster/immutable plan digest与eval protocol version派生。Crash replay同id，cluster/plan/scope/case改变则不同。Permit id可写入disposable `ConsolidationAttempt`供重放审计，但不是process authority、不进rollout artifact，production parser拒绝。
- 验收：`eval-consolidation-permit-id-replay-stable`、`eval-consolidation-permit-binds-case-scope-cluster-plan-and-version`（T93）、`eval-consolidation-permit-not-model-supplied`、`eval-consolidation-permit-cannot-parse-as-rollout-capability`。

#### `loadEvalManifest(path): EvalManifest`
- 拓扑：P5-D02。
- 职责：只做fail-closed schema parse、`evalProtocolVersion=2`、九个strata、named profile与待评测scope fields、target rollout level/capabilities、`minValidRepeats/maxRepeatAttempts`与path form；要求min repeats≥3且max不小于min。不读fixture，不声称digest/split已通过。V1 七分层manifest/report/authorization一律拒绝。Threshold、scope、level/capability或repeat aggregation变化必须新protocol version。
- 验收：`manifest-v2-nine-strata-schema-valid`、`manifest-v1-report-and-authorization-rejected-by-v2`、`missing-stratum-profile-level-or-scope-field-fails-schema`、`historical-source-route-cannot-declare-eval-scope`（T92）、`unsafe-fixture-path-fails`、`invalid-repeat-bounds-fail`、`threshold-scope-or-level-change-requires-protocol-version`。

#### `verifyFixtureDigests(manifest): VerifiedFixtureSet`
- 拓扑：P5-D03；调用 D02 结果。
- 职责：逐项读取 fixture/oracle/recorded output，校验 input/oracle/output digest 与唯一 case id；任何缺失、重复或篡改 fail-closed，成功后返回不可变 verified refs。
- 验收：`fixture-digest-tamper-fails`、`oracle-digest-tamper-fails`、`recorded-output-digest-tamper-fails`、`duplicate-case-id-fails`。

#### `validateSplitIsolation(manifest,verified): ValidatedEvalCorpus`
- 拓扑：P5-D04；调用 D01 `minimumPassableWilsonCases` 与 D03 verified refs。
- 职责：从每个named profile scope字段调用P3 canonical helper重算`ReviewAuthorizationScopeDigest`；证明每个scope九层都存在、calibration/held-out无case/digest交集、各层unique下限和总数≥333，并验证每个binary Wilson门可达。Provider repeats、historical source routes与其他scope结果不参与本scope样本数；返回D05唯一可接受corpus handle。
- 验收：`missing-stratum-fails`、`execution-scope-digest-is-derived-not-trusted`（T88）、`scope-count-equals-configured-named-profiles-not-source-routes`（T92）、`heldout-minimum-333-enforced-per-scope`、`changed-method-recovery-requires-thirty-five-unique-cases`（T94）、`skill-consolidation-requires-thirty-five-unique-cases`（T93）、`perfect-thirty-cannot-satisfy-point-nine-wilson`、`zero-events-in-thirty-cannot-satisfy-point-one-upper-bound`、`repeated-skill-reuse-requires-thirty-five-unique-cases`、`manifest-threshold-must-be-mathematically-passable`、`provider-repeats-do-not-increase-independent-case-count`、`different-scope-results-never-pool-samples`（T88）、`split-overlap-fails`。

#### `loadFixture(corpus,caseRef): LoadedFixture`
- 拓扑：P5-D05；只接 D04 validated corpus。
- 职责：durable events 按 seq 连续、branded ids/scope 相容、resource base 可回放；扫描 fixture 防凭据/本机绝对路径进库，保留 scorer-only oracle 但不输出 runner input。
- 验收：`fixture-events-contiguous`、`fixture-scope-resolves`、`fixture-secret-scan-blocks`、`fixture-machine-path-blocks`、`unvalidated-case-ref-rejected`。

#### `redactOracleForRunner(fixture): RunnerFixture`
- 拓扑：P5-D06；调用 D05 loaded fixture。
- 职责：删除 oracle、expected labels、threshold、split-only notes 与 scorer metadata；返回值类型不提供这些字段，runner 只接受该类型。
- 验收：`runner-input-contains-no-oracle`、`runner-input-contains-no-threshold`、`redaction-does-not-change-durable-input-digest`。

#### `createEvalComposition(fixture): EvalComposition`
- 拓扑：P5-D07；只接 D06 runner fixture。
- 职责：用 fixture 专属 storage root、filesystem root、ProjectKey namespace 与无开发者 profile 的 Cordis test composition 装配 shipped P1–P4 Services/loaders；为该root创建进程内`EvaluationPromotionAuthority`、`EvaluationConsolidationAuthority`与对应eval-only adapters，authority不进fixture/record/report。任何配置 domain 与 fixture root 不一致立即失败。
- 验收：`eval-composition-uses-fixture-roots-only`、`eval-composition-has-no-developer-profile`、`eval-composition-rejects-configured-runtime-root`、`eval-authority-is-process-local-and-root-bound`、`eval-authority-cannot-be-serialized-or-reused-across-compositions`。

#### `replayProtocolCase(fixture,recordedOutput): ProtocolCaseResult`
- 拓扑：P5-D08；调用 D07 composition。
- 职责：在隔离 composition 中免 key 回放 P3 plan gate/admission/saga/finalization 和 P1/P2/P4 投影；每个 durable write 边界注入 crash 并重启；采集 resource diffs、receipts、cursor/attempt、published snapshot、provider catalog、usage/coverage。同一 fixture 重复两次必须 byte-stable。
- 验收：`protocol-replay-keyless`、`crash-matrix-converges`、`replay-no-duplicate-visible-mutation`、`replay-byte-stable`、`replay-never-writes-nonfixture-domain`。

#### `applyCandidateWithProductionPolicyInEvalDomain(fixture,protocolResult,repeatIndex): EvalResources`
- 拓扑：P5-D09。
- 职责：只接受D08证明通过当前evidence/outcome/repair/target/scan/quota/publication admission的exact shadow plan；复用D07 composition，按正式memory→skill顺序调用public mutation API并完成隔离ledger cleanup。Memory通过shipped Publisher读取。Skill draft用D01派生promotion permit，向正式P2 `decideSkillPromotion`提供除已签rollout authorization外与production相同的candidate facts，再以D07 promotion authority调用eval-only adapter进入同一private activation transaction；owner、strong evidence、unresolved、pin/opt-in、exact revision/digest、structure与CAS均重验。Changed-method单episode必须保持draft；corroborated fixture才可activate。Consolidation case以D01派生的exact promotion/consolidation permits和D07彼此独立的两类authorities走P4b destination-first runtime；P4必须先持久化immutable plan与成功preflight，再派生、持久化`ConsolidationPromotionEvidence`，P2以该evidence走同一promotion policy。Eval inputs只分别替代待签`skill-auto-promotion`与`skill-consolidation`能力；crash恢复先重验fixture/permits、重建current-root authorities，再续同attempt。禁止human governance approve、direct body injection、真实domain/key、sidecar篡改或Provider绕过；case结束先dispose两类authority/adapters再销毁root。
- 验收：`eval-domain-rejects-unadmitted-shadow-plan`、`eval-domain-uses-public-production-services-and-policy`（T91）、`eval-domain-project-keys-are-fixture-scoped`、`eval-domain-never-opens-configured-runtime-domain`、`eval-permit-substitutes-authorization-only`（T91）、`eval-and-production-promotion-decisions-match`（T91）、`eval-auto-promotion-crash-replays-same-activation-op-id`（T91）、`single-repair-episode-remains-invisible`（T94）、`ordinary-user-text-cannot-substitute-repair-evidence-operation`（T94）、`exact-human-repair-confirmation-follows-production-admission`（T94）、`corroborated-repair-uses-same-auto-activation`（T94）、`consolidation-uses-p4b-destination-first-runtime`（T93）、`eval-consolidation-persists-host-derived-promotion-evidence`（T93）、`eval-consolidation-requires-both-domain-permits-and-authorities`（T93）、`eval-consolidation-resume-revalidates-permit-and-root-authority`（T93）、`human-governance-approval-forbidden-in-auto-eval`、`failed-policy-never-injects-draft-body`、`eval-permit-never-enters-rollout-authorization`、`eval-domain-disposes-after-case`、`repeated-task-sees-only-published-and-provider-loaded-resources`。

#### `runControlledCase(fixture,reviewExecutionScope,repeat): Promise<ModelCaseResult>`
- 拓扑：P5-D10；调用 D09 为重复任务建隔离 candidate context。
- 职责：分别在锁定baseline与candidate shadow profile运行同一redacted学习输入。Candidate output先经D08 keyless protocol replay；通过后才调D09按目标level模拟production policy，随后以同一repeated-task input比较base与candidate resources。Review planner必须来自manifest named profile，resolved config/adapter/isolated EpochHeader/schema/policy versions与actual attestation均等于exact scope；historical source route只记录provenance，不改变scope。Repeated-task route固定记录但不进入review scope。每repeat记录scope/attestation/usage/terminal、eval permits、promotion decisions、activation lineage和consolidation attempts。Infra failure可在cap内补跑；scope/attestation mismatch、human approval、正式domain write或permit越权是不可补跑hard breach。
- 验收：`baseline-candidate-learning-input-identical`、`baseline-candidate-repeated-task-input-identical`、`candidate-output-replays-before-eval-materialization`、`unreplayed-candidate-plan-cannot-enter-eval-domain`、`review-profile-scope-and-actual-attestation-recorded`（T88/T92）、`historical-source-route-does-not-change-run-scope`（T92）、`adapter-default-or-prompt-drift-hard-fails-run`、`minimum-valid-repeats-enforced`、`repeat-attempt-cap-enforced`、`provider-failure-not-scored-as-abstention`、`scope-mismatch-not-reclassified-infra-invalid`、`insufficient-valid-repeats-invalidates-case`、`controlled-candidate-learning-shadow-only`、`candidate-repeat-uses-disposable-eval-domain`。

#### `scoreCase(result,oracle): CaseScore`
- 拓扑：P5-D11。
- 职责：先对每个valid repeat输出breaches、TP/FP/FN、abstention、纠错可见性、retry/changed-method路径、skill proposal/production visibility、重复任务、重犯/wasted calls、consolidation destination/source preservation，再折叠一个独立`CaseScore`。`proposalClean/learningComplete/abstention/exactCapture/recoveryCorrect/relevantDraft/productionSkillEffective/consolidationCorrect`只有全部valid repeats满足才true。P3确定性admission rejection按proposal计FP/FN。语义oracle允许paraphrase，但production policy的digest/identity比较仍exact；failed path作为明确conditioned avoid可保留，作为recommended workflow是breach。
- 验收：`score-exact-oracle-vectors`、`paraphrase-with-same-fact-can-match`、`opposite-fact-is-false-positive`、`proposal-clean-false-on-any-repeat-fp`、`learning-complete-requires-all-items-in-every-valid-repeat`、`repeat-fold-produces-one-independent-case`、`failed-step-recommended-is-breach`、`conditioned-avoid-does-not-count-as-recommended-step`（T94）、`production-visible-skill-scored-separately-from-draft`（T91）、`consolidation-unique-oracle-item-loss-is-breach`（T93）、`unrelated-skill-merge-is-breach`（T93）、`no-signal-empty-plan-is-correct-abstention`、`deterministic-admission-rejection-is-scored-not-infra-invalid`（T86）、`wasted-tool-call-count-pinned`。

## 5. 聚合阈值与 gate

#### `confidenceBounds` / `pairedNonInferiority` → `aggregateByStratum`
- 拓扑：P5-D12。
- 职责：D12内部先分别实现并钉死Wilson与paired bootstrap叶函数，再实现调用二者的stratum aggregation。每层以unique held-out case独立计数；proposal/learning/abstention/exact capture/retry recovery/changed-method/relevant draft/production effect/consolidation等binary指标用95% Wilson bound。TP/FP/FN micro只诊断。只有baseline/candidate success、重犯、wasted-call差使用case-paired 95% bootstrap；provider repeats先折叠，不能扩大n。Draft与auto target level分别聚合，不能用潜在批准后效用替代production-reachable effect。
- 验收：`wilson-vectors-pinned`、`minimum-passable-wilson-case-vectors`、`proposal-micro-counts-never-enter-confidence-bound`、`all-success-case-rate-still-has-wilson-uncertainty`、`paired-bootstrap-seed-repeatable`、`provider-repeats-fold-before-confidence-bound`、`strata-never-pooled-for-pass`、`infra-invalid-reduces-sample-not-quality-denominator`、`insufficient-valid-samples-block-gate`。

#### `evaluateQualityGate(manifest,aggregate): GateDecision`
- 拓扑：P5-D13。
- correctness hard gate（执行到的calibration+held-out必须为0）：既有memory/planner/attestation/isolation/cross-scope/shadow/whole-plan/crash/scan breach继续有效；另加user-owned/pinned/auto-disabled/weak-evidence/unresolved/stale-base skill自动可见；evaluation permit进入production或绕过除authorization外任一policy check；historical source route改变受测scope；单RepairEpisode或未planner自称确认的普通user text直接可见；failed path作为recommended workflow；destination active前source archive；source bundle不可restore；consolidation planner未读exact source bundle却archive；human evaluator approval替代auto path。D09一次性domain不是正式write，但越界即hard breach。P5 profile pass不能豁免任一candidate-specific breach。
- manifest v2 statistical gate（held-out逐层）：proposal-clean Wilson LCB≥0.80；learning-complete≥0.60；no-learning abstention≥0.95；user-correction exact capture≥0.90；failure-recovery working-path correctness≥0.80；relevant managed-skill draft≥0.75。`changed-method-recovery`另要求working path capture且failed path不被推荐的Wilson LCB≥0.80、错误promotion rate Wilson upper bound≤0.10。`skill-consolidation`要求unique oracle preservation与unrelated non-merge各自Wilson LCB≥0.90。Micro只进报告；calibration不进发布估计。
- repeated-skill-reuse非劣门保持success/重犯/wasted-call三项bounds。对`conservative-draft`，该层只报告“人工/评测permit后潜在效用”，不签`skill-auto-promotion`。`conservative-auto`必须额外满足production-policy visibility rate、changed-method与consolidation门，并由同一D09 path产生实际visible skill；只有consolidation stratum通过才可在同一scope entry同时签`skill-auto-promotion`与`skill-consolidation`，不允许只有后者的不可达组合。任一层不足、hard/stat/noninferiority失败均不得签对应level；auto失败但draft全部通过时最多签draft。
- 验收：`hard-breach-always-fails`、`oracle-forbidden-current-memory-authority-is-hard-breach`、`stale-memory-authority-after-correction-or-read-failure-is-hard-breach`（T87）、`ordinary-planner-tool-or-nonexact-structured-output-is-hard-breach`（T89）、`review-execution-attestation-mismatch-is-hard-breach`（T88）、`protected-or-weak-evidence-auto-promotion-is-hard-breach`（T91）、`eval-permit-production-leak-is-hard-breach`（T91）、`source-route-scope-coupling-is-hard-breach`（T92）、`single-episode-visible-learning-is-hard-breach`（T94）、`archive-before-active-destination-is-hard-breach`（T93）、`proposal-clean-threshold-cannot-waive-visible-false-memory`、`micro-precision-never-substitutes-case-rate`、`human-signoff-cannot-waive-hard-gate`、`each-stat-threshold-exact-boundary`、`draft-pass-auto-fail-authorizes-draft-only`（T91）、`calibration-never-enters-statistical-release-estimates`、`one-stratum-regression-fails-overall`、`repeated-task-noninferiority-required`、`insufficient-evidence-keeps-shadow`、`repeated-runs-cannot-satisfy-unique-case-floor`、`deterministic-rejection-cannot-inflate-abstention-or-valid-sample-count`（T86）、`model-confidence-never-enters-gate`（T83）。

#### `buildQualityReport(decision,results): QualityReport`
- 拓扑：P5-D14；调用 D13 decision，不重算 gate。
- 职责：按exact named review scope生成machine JSON与中文Markdown，列manifest/input、profile id、scope fields/digest、actual attestations、historical source route仅作provenance计数、repeated-task route、eval permits/promotion decisions、每层point/bound/failure与hard breach，并分别给draft/auto最高可授权level。同一输入byte-stable；scope间决策分开，报告不把proposal-only潜在效用写成production auto effect。
- 验收：`report-complete-and-deterministic`、`report-preserves-per-scope-and-level-decision`、`report-includes-profile-scope-and-actual-attestations`（T88/T92）、`report-labels-draft-benefit-as-potential-only`（T91）、`report-includes-repair-and-consolidation-strata`（T93/T94）、`report-redacts-sensitive-session-content-and-credentials`。

#### `buildRolloutAuthorization(decision,report,signature): RolloutAuthorization`
- 拓扑：P5-D15；调用 D13/D14 outputs。
- 职责：只有exact scope的machine gate对目标level pass且人工审阅签字，才加入`{scopeDigest,maxLevel,capabilities,reportDigest}`。Artifact为`{from:'shadow',authorizedScopes,versions,approvedBy,approvedAt,signature,artifactDigest}`，签名覆盖canonical whole artifact。Draft pass只能含`durable-memory|skill-draft`；auto pass才可含`skill-auto-promotion`，consolidation stratum通过后才可在同一scope entry追加`skill-consolidation`，不得生成只有consolidation而无auto-promotion的entry。失败scope/level不得混入；同scope/level新passing report可重签而scope digest不变。Authorization不改cordis.yml、不复制shadow plan、不含eval permit/session content/credentials，也不批准具体future mutation。
- 验收：`failed-scope-has-no-authorization-entry`、`unsigned-pass-has-no-authorization`、`draft-pass-cannot-carry-auto-or-consolidation-capability`（T91/T93）、`consolidation-capability-requires-auto-promotion-in-same-scope-entry`（T93）、`auto-entry-binds-scope-level-capabilities-report-and-versions`、`authorization-signature-and-artifact-digest-verify`、`authorization-resign-keeps-scope-identity`、`authorization-excludes-evaluation-permits-and-secrets`、`authorization-does-not-mutate-runtime-config-or-approve-plan`。

#### top-level scripts
- 拓扑：P5-D16。
- 职责：`test:self-evolution-eval` 运行 schema/digest/keyless replay/scorer/gate 金向量；`verify:self-evolution-rollout` 先验证工作树/route/credentials/manifest，再运行 baseline+candidate、评分和报告，任一 fail/manual/infra-invalid 非零退出。注册为 executed repository gate，不允许只在文档声称运行过。
- 验收：`keyless-command-runs-on-clean-tree`、`controlled-command-rejects-unlocked-route`、`failure-exits-nonzero`、`report-path-printed`、`gate-registered-in-run-gates`。

## 6. shadow → conservative-draft → conservative-auto 手动切换协议

1. 发布者逐named scope核对machine report、失败case与成本，分别签最高draft或auto level；hard gate不可人工豁免，不同scope结果不可合并，draft潜在效用不能签auto capability。
2. 独立配置变更把rollout level从shadow改为conservative-draft并引用artifact；每个live/historical session先选择named profile、再在claim前重算scope。不在authorizedScopes或level不足时只进入shadow lane。
3. Auto strata与production-policy path全部通过后，可再把同scope升级为conservative-auto。P3因level或stable scope不同派生新cursor lane；artifact/report/签字变化但scope+level相同不新建lane。旧lane/attempt只读保留，新lane从未review开始，historical coordinator重审。
4. 每个draft/auto plan仍重跑当前exact target/evidence/outcome/repair/whole-plan admission。Auto skill另逐candidate调用P2 policy；P4b consolidation另执行destination-first attempt。Gate通过不批准任何具体mutation，evaluation permit也不能重放到production。
5. Operational correctness alert、分层质量回归或人工治理可从auto回滚draft或shadow；已提交资源不自动撤回，通过provenance+correct/remove/reject/pin/archive/restore纠正。

验收：`shadow-authorization-does-not-copy-cursor`（T83）、`draft-and-auto-create-distinct-new-lanes`（T83/T91）、`unapproved-level-never-claims-conservative-lane`（T88/T91）、`authorization-resign-does-not-create-another-lane`、`historical-sessions-replanned-with-named-profile`（T92）、`old-shadow-plan-and-eval-permit-never-executed`、`rollback-auto-to-draft-preserves-provenance`、`rollback-does-not-delete-audit-history`。

## 7. Phase 出口

P5-D01–D16全绿；keyless command进入CI/repository gate；每个待授权named scope的controlled报告独立达到九层333-case下限与目标level阈值；T83/T86–T94、eval-domain permit isolation、hard crash/security/scope/attestation、draft/auto lanes和P4b destination-first REAL boot通过；报告与authorization不含敏感会话原文、credential或eval permit；README/Agent Note说明P5不是单candidate truth proof、provider nondeterminism、named execution profile、draft/auto语义、阈值版本与人工签字职责。在此之前RC5.5.5只允许shadow。

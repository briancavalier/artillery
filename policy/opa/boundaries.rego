package darkfactory

deny[msg] if {
  edge := input.imports[_]
  edge.fromDomain == "factory-core"
  edge.toDomain == "game"
  msg := sprintf("factory-core must not import game internals: %s -> %s", [edge.from, edge.to])
}

deny[msg] if {
  edge := input.imports[_]
  edge.fromDomain == "factory-runner"
  edge.toDomain == "game"
  msg := sprintf("factory-runner must not import game internals: %s -> %s", [edge.from, edge.to])
}

deny[msg] if {
  edge := input.imports[_]
  edge.fromDomain == "factory-api"
  edge.toDomain == "game"
  msg := sprintf("factory-api must not import game internals: %s -> %s", [edge.from, edge.to])
}

deny[msg] if {
  edge := input.imports[_]
  edge.fromDomain == "game"
  edge.toDomain == "factory-core"
  msg := sprintf("game must not import factory-core: %s -> %s", [edge.from, edge.to])
}

deny[msg] if {
  edge := input.imports[_]
  edge.fromDomain == "game"
  edge.toDomain == "factory-runner"
  msg := sprintf("game must not import factory-runner: %s -> %s", [edge.from, edge.to])
}

deny[msg] if {
  edge := input.imports[_]
  edge.fromDomain == "game"
  edge.toDomain == "project-adapter"
  msg := sprintf("game must not import project adapters: %s -> %s", [edge.from, edge.to])
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.triggerPullRequestLike
  workflow.usesProdSecret
  msg := sprintf("pull_request context workflow references prod secret: %s", [workflow.file])
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.triggerPullRequestLike
  workflow.usesEnvironmentProd
  msg := sprintf("pull_request context workflow references production environment: %s", [workflow.file])
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-controller.yml"
  not workflow.specController.hasAnalyzePermissions
  msg := "spec-controller workflow missing required analyze job permissions"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-controller.yml"
  not workflow.specController.hasMutatePermissions
  msg := "spec-controller workflow missing required mutate job permissions"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-controller.yml"
  not workflow.specController.hasAttestationPermission
  msg := "spec-controller workflow missing attestations: write permission"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-controller.yml"
  workflow.specController.usesProdSecret
  msg := "spec-controller workflow must not reference production secrets"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-controller.yml"
  workflow.specController.usesProductionEnvironment
  msg := "spec-controller workflow must not reference production environment"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-controller.yml"
  workflow.specController.checksOutHeadRef
  msg := "spec-controller workflow must not checkout pull request head ref"
}

deny[msg] if {
  issue := input.contracts.issues[_]
  msg := sprintf("contract issue: %s", [issue])
}

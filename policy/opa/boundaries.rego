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
  edge.fromDomain == "implementation-provider"
  edge.toDomain == "game"
  msg := sprintf("implementation-provider must not import game internals: %s -> %s", [edge.from, edge.to])
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
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-execution.yml"
  not workflow.specExecution.hasPermissions
  msg := "spec-execution workflow missing required permissions"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-execution.yml"
  not workflow.specExecution.hasAttestationPermission
  msg := "spec-execution workflow missing attestations: write permission"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-execution.yml"
  workflow.specExecution.usesProdSecret
  msg := "spec-execution workflow must not reference production secrets"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-execution.yml"
  workflow.specExecution.usesProductionEnvironment
  msg := "spec-execution workflow must not reference production environment"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-architecture.yml"
  not workflow.specArchitecture.hasPermissions
  msg := "spec-architecture workflow missing required permissions"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-architecture.yml"
  not workflow.specArchitecture.hasAttestationPermission
  msg := "spec-architecture workflow missing attestations: write permission"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-architecture.yml"
  workflow.specArchitecture.usesProdSecret
  msg := "spec-architecture workflow must not reference production secrets"
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.file == ".github/workflows/spec-architecture.yml"
  workflow.specArchitecture.usesProductionEnvironment
  msg := "spec-architecture workflow must not reference production environment"
}

deny[msg] if {
  issue := input.contracts.issues[_]
  msg := sprintf("contract issue: %s", [issue])
}

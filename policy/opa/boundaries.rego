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
  workflow.triggerPullRequest
  workflow.usesProdSecret
  msg := sprintf("pull_request workflow references prod secret: %s", [workflow.file])
}

deny[msg] if {
  workflow := input.workflows[_]
  workflow.triggerPullRequest
  workflow.usesEnvironmentProd
  msg := sprintf("pull_request workflow references production environment: %s", [workflow.file])
}

deny[msg] if {
  issue := input.contracts.issues[_]
  msg := sprintf("contract issue: %s", [issue])
}

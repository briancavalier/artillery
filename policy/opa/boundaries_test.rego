package darkfactory

test_no_denies_for_valid_input if {
  test_input := {
    "imports": [],
    "workflows": [],
    "contracts": {"issues": []}
  }
  denies := data.darkfactory.deny with input as test_input
  count(denies) == 0
}

test_deny_spec_controller_missing_permissions if {
  test_input := {
    "imports": [],
    "contracts": {"issues": []},
    "workflows": [{
      "file": ".github/workflows/spec-controller.yml",
      "triggerPullRequestLike": true,
      "usesProdSecret": false,
      "usesEnvironmentProd": false,
      "specController": {
        "hasAnalyzePermissions": false,
        "hasMutatePermissions": true,
        "hasAttestationPermission": true,
        "usesProdSecret": false,
        "usesProductionEnvironment": false,
        "checksOutHeadRef": false
      }
    }]
  }
  denies := data.darkfactory.deny with input as test_input
  denies["spec-controller workflow missing required analyze job permissions"]
}

test_deny_spec_controller_unsafe_checkout if {
  test_input := {
    "imports": [],
    "contracts": {"issues": []},
    "workflows": [{
      "file": ".github/workflows/spec-controller.yml",
      "triggerPullRequestLike": true,
      "usesProdSecret": false,
      "usesEnvironmentProd": false,
      "specController": {
        "hasAnalyzePermissions": true,
        "hasMutatePermissions": true,
        "hasAttestationPermission": true,
        "usesProdSecret": false,
        "usesProductionEnvironment": false,
        "checksOutHeadRef": true
      }
    }]
  }
  denies := data.darkfactory.deny with input as test_input
  denies["spec-controller workflow must not checkout pull request head ref"]
}

test_deny_spec_execution_missing_permissions if {
  test_input := {
    "imports": [],
    "contracts": {"issues": []},
    "workflows": [{
      "file": ".github/workflows/spec-execution.yml",
      "triggerPullRequestLike": false,
      "usesProdSecret": false,
      "usesEnvironmentProd": false,
      "specExecution": {
        "hasPermissions": false,
        "hasAttestationPermission": true,
        "usesProdSecret": false,
        "usesProductionEnvironment": false
      }
    }]
  }
  denies := data.darkfactory.deny with input as test_input
  denies["spec-execution workflow missing required permissions"]
}

test_deny_spec_execution_prod_secret if {
  test_input := {
    "imports": [],
    "contracts": {"issues": []},
    "workflows": [{
      "file": ".github/workflows/spec-execution.yml",
      "triggerPullRequestLike": false,
      "usesProdSecret": false,
      "usesEnvironmentProd": false,
      "specExecution": {
        "hasPermissions": true,
        "hasAttestationPermission": true,
        "usesProdSecret": true,
        "usesProductionEnvironment": false
      }
    }]
  }
  denies := data.darkfactory.deny with input as test_input
  denies["spec-execution workflow must not reference production secrets"]
}

test_deny_spec_architecture_missing_permissions if {
  test_input := {
    "imports": [],
    "contracts": {"issues": []},
    "workflows": [{
      "file": ".github/workflows/spec-architecture.yml",
      "triggerPullRequestLike": false,
      "usesProdSecret": false,
      "usesEnvironmentProd": false,
      "specArchitecture": {
        "hasPermissions": false,
        "hasAttestationPermission": true,
        "usesProdSecret": false,
        "usesProductionEnvironment": false
      }
    }]
  }
  denies := data.darkfactory.deny with input as test_input
  denies["spec-architecture workflow missing required permissions"]
}

test_deny_spec_architecture_prod_secret if {
  test_input := {
    "imports": [],
    "contracts": {"issues": []},
    "workflows": [{
      "file": ".github/workflows/spec-architecture.yml",
      "triggerPullRequestLike": false,
      "usesProdSecret": false,
      "usesEnvironmentProd": false,
      "specArchitecture": {
        "hasPermissions": true,
        "hasAttestationPermission": true,
        "usesProdSecret": true,
        "usesProductionEnvironment": false
      }
    }]
  }
  denies := data.darkfactory.deny with input as test_input
  denies["spec-architecture workflow must not reference production secrets"]
}

test_deny_implementation_provider_importing_game if {
  test_input := {
    "contracts": {"issues": []},
    "workflows": [],
    "imports": [{
      "from": "packages/implementation-provider-codex/src/provider.ts",
      "to": "apps/artillery-game/src/server/http.ts",
      "fromDomain": "implementation-provider",
      "toDomain": "game"
    }]
  }
  denies := data.darkfactory.deny with input as test_input
  denies["implementation-provider must not import game internals: packages/implementation-provider-codex/src/provider.ts -> apps/artillery-game/src/server/http.ts"]
}

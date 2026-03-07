package darkfactory

test_no_denies_for_valid_input if {
  input := {
    "imports": [],
    "workflows": [],
    "contracts": {"issues": []}
  }
  count(data.darkfactory.deny with input as input) == 0
}

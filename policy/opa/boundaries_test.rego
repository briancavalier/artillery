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

Feature: Start a named main agent
  A user can talk directly to any declared agent without duplicating its configuration.

  Scenario: Start a direct session with a declared agent
    Given a user agent named "leader" declares its prompt, model, thinking level, and tools
    When the user starts Pi with "pi --agent leader"
    Then the main session uses the declared agent configuration
    And the same "leader" definition remains available for subagent delegation

  Scenario: Reject an unknown main agent
    Given no declared agent is named "missing"
    When the user starts Pi with "pi --agent missing"
    Then Pi reports that the named agent was not found
    And no partial agent configuration is applied

  Scenario: Preserve the declared project-context boundary
    Given "leader" replaces Pi's base prompt and inherits project instructions but not global skills
    When the user starts Pi with "pi --agent leader"
    Then the main prompt contains the leader instructions and project AGENTS.md content
    And the main prompt does not contain Pi's base prompt or the global skills catalog

  Scenario: Load only the skills selected by the main agent
    Given "leader" does not inherit global skills and selects the "bdd" skill
    When the user starts Pi with "pi --agent leader"
    Then the main prompt advertises the "bdd" skill
    And the main prompt does not advertise unrelated global skills

  Scenario: Load the declared agent memory
    Given "leader" declares a user-scoped memory named "leader"
    When the user starts Pi with "pi --agent leader"
    Then the main prompt contains the current "leader" memory

  Scenario: Resume a named main-agent session
    Given an existing session was started with "pi --agent leader"
    When the user resumes that session without repeating the flag
    Then the resumed main session still uses "leader"

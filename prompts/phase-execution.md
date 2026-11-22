# Execution Phase — {{phase_label}}

## Context
- **Change ID**: {{change_id}}
- **Phase**: {{phase_id}} ({{phase_label}})
- **Artifact Directory**: {{artifact_dir}}

## Intake
{{intake}}

## Task
Produce the real artifact for this phase and any necessary supporting changes.

## Phase Guidance
{{phase_guidance}}

### Requirements
1. Start from the change status and this phase's named inputs. Read only the artifacts this phase consumes (typically the plan and the previous phase's primary artifact); do not re-read the whole artifact directory — every file read is re-read again on later turns
2. Perform the actual work required for this phase according to the frozen scope
3. Write the primary phase artifact to `{{expected_artifact}}`
4. Ensure the artifact is concrete and downstream-gate ready, not placeholder prose
5. If code or design artifacts must change, update the project checkout directly

### Artifact Expectations
The primary artifact should contain phase-appropriate structured evidence such as:
   - `phase_id`: "{{phase_id}}"
   - `summary`: "What was implemented"
   - `files_changed`: ["list", "of", "files"]
   - `verification`: "commands run and results"

### Output
Write the primary artifact to: `{{expected_artifact}}`

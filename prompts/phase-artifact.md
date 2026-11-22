# Heavy Phase — {{phase_label}}

## Context
- **Change ID**: {{change_id}}
- **Phase**: {{phase_id}} ({{phase_label}})
- **Artifact Directory**: {{artifact_dir}}

## Intake
{{intake}}

## Task
Produce the primary artifact for this phase and any required supporting outputs.

### Primary Output
Write the primary artifact to: `{{expected_artifact}}`

### Supporting Outputs
{{auxiliary_outputs}}

### Requirements
1. Start from the change status and this phase's named inputs. Read only the artifacts this phase consumes (typically the plan and the previous phase's primary artifact); do not re-read the whole artifact directory — every file read is re-read again on later turns
2. Perform the work required for this phase instead of writing placeholder prose
3. Keep outputs consistent with the current phase semantics and downstream gates
4. If code or design artifacts must change, update the project checkout directly

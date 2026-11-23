# Judging Review Findings

A reviewer's finding is the opinion of someone seeing the code for the first time. It is input, not an order. Whoever acts on a review judges every finding themselves — is it right or wrong, and does it matter for what the change sets out to do — before changing anything. Act only on findings that are right and that the change's purpose needs: a real safety, data or behavior defect. Do not act on Out of scope or Improbable findings. Do not add a mechanism to answer a finding that is remote, cosmetic or outside the change's purpose; narrow the claim, delete, or leave it. When the same kind of finding keeps returning, the design is too complicated: simplify it instead of adding to it. A reviewer's verdict does not decide whether a change lands; the person acting on the review does.

But stay cold. The one judging is usually the one who wrote the code, and the pull to finish makes an inconvenient finding look remote, cosmetic or Improbable. Check each finding against the code, not against your memory of writing it, before setting it aside, and state why it does not hold.

Not acting on a finding is not the same as not knowing it. A finding judged real but left out of the change — Out of scope, Improbable, or remote — is reported to the owner with what it risks and who owns it, and one that states a requirement is recorded in the open-findings note.

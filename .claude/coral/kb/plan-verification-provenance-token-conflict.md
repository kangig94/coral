# Provenance Phrases Can Trigger Domain-Neutrality Banned-Token Scans

## Rule
When a domain-neutral methodology file references its intellectual source (e.g., "Altshuller analyzed 40,000 patents"), historically accurate provenance terms can match a whole-file banned-token scan. Write provenance in terms of what was studied (inventive solutions, recorded cases, empirical observations), not the domain-specific container (patents, clinical trials, experiments). This produces both scan-clean files and clearer writing.

## Why
HOW-RESOLVE.md opened with "Genrich Altshuller analyzed 40,000 patents." The word `patent` was in the banned-token list (VS16), causing the verification to fail. The plan's synthesis had decided to run the grep whole-file without exemptions — a deliberate simplification — but failed to account for provenance language. The fix was to rephrase to "thousands of recorded inventive solutions," which is actually more informative: it describes what Altshuller was cataloguing (inventive solutions) rather than their legal vehicle (patents).

## Pattern
**Wrong**: "Altshuller analyzed 40,000 **patents** and found..." — `patent` triggers the ban.
**Right**: "Altshuller analyzed thousands of recorded **inventive solutions** and found..." — ban-clean and more precise.

**General rule**: When writing the opening provenance sentence for a HOW file, describe the empirical basis (what was studied, how many cases, what was found) rather than the domain-specific label for those cases. This avoids the token conflict and often produces clearer framing.

**Verification step guidance**: When a plan includes a whole-file banned-token scan, verify that the file's opening paragraph (which typically contains provenance) does not use any token from the ban list. Do this before writing the implementation, not after.

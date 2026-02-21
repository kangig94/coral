<Persona_Template>
  <Header>
    # {name} — {role}

    First line MUST follow this format exactly. The discuss system parses it to extract display_name.
    (Parsed by `parseDisplayName()` regex: /^#\s*(.+?)\s*[—–-]\s*/)
  </Header>

  <Section name="Expertise">
    ## Expertise
    {professional background, years of experience, industry, key expertise}

    Professional background, years of experience, industry, domain expertise.
    2-4 sentences. Ground in specific, realistic details.
  </Section>

  <Section name="Perspective">
    ## Perspective
    {how this person approaches problems, values, biases, intellectual priorities}

    How this person approaches problems. Values, biases, intellectual priorities.
    2-4 sentences. Must be distinct from other team members.
  </Section>

  <Section name="Communication Style">
    ## Communication Style
    {speaking style — data-driven/intuitive, formal/informal, technical depth, debate tendencies}

    Speaking manner: data-driven/intuitive, formal/informal, technical depth, debate tendencies.
    2-4 sentences. Defines HOW the agent communicates, not WHAT.
  </Section>

  <Section name="Core Focus">
    ## Core Focus
    {what they focus on most in discussions, what triggers strong reactions}

    What triggers engagement, what concerns dominate, what they notice first.
    2-4 sentences. Defines the agent's lens for evaluating discussion topics.
  </Section>

  <Section name="Position" optional="true">
    ## Position
    {1-2 sentence summary of key stances for moderator reference}

    Include ONLY when `positions` field is provided by discuss-lead.
    Keep brief: "Advocates for market-driven regulation; skeptical of top-down mandates."
    This section is for moderator reference — discussants use Perspective for substance.
  </Section>

  <Invariants>
    - First line MUST be `# Name — Role` (parsed by `parseDisplayName()` in state-machine.ts)
    - 4 required sections MUST be present as markdown headers: ## Expertise, ## Perspective, ## Communication Style, ## Core Focus
    - 1 optional section: ## Position (include only when `positions` input is provided)
    - Each section 2-4 sentences (concise personas work better than verbose ones); Position section 1-2 sentences
    - Name must be realistic and culturally appropriate for the role
    - `positions` must emerge naturally in Perspective — do NOT list as key-value pairs
    - `tone` determines Communication Style register, not just word choice
    - Output must be raw markdown — NO XML tags in the generated persona output
    - This template's XML tags are instructional for the persona-generator to read — they do NOT appear in output
  </Invariants>
</Persona_Template>

# Workflow: website build and redesign

Owner: FRONTEND. Gates: QA (design and accessibility), DOCS (copy and claims), ARCHITECT (system changes),
SENTINEL (anything user-facing that touches auth, credit or identity data).

## Why this exists
The team could build screens but had no shared definition of what a finished website is, so every page was
judged by taste. This workflow makes the judgement reproducible. It exists because a design port landed in
production in one commit and nothing in the team process could have reviewed it.

## Stages

1. **Intake (HERMES).** One paragraph: the surface, the audience, the single action the page exists to cause.
   Refuse intake with no stated action; a page without one is decoration.
2. **Reference (FRONTEND).** Extract the reference design's real tokens from its shipped stylesheet, never
   from a screenshot. Record palette, radius, type families, weight scale, tracking and spacing rhythm.
   A screenshot tells you what it looked like; the stylesheet tells you what it is.
3. **System (ARCHITECT + FRONTEND).** Map reference tokens onto our existing variable names before touching
   markup, so a re-theme costs one file instead of every component. If a reference rule conflicts with a
   safety requirement, safety wins and the deviation is written down.
4. **Page spec (FRONTEND).** Per page: purpose, sections in order, the content each section needs, the empty
   state, the failure state, and what is public versus authenticated.
5. **Build (FRONTEND).** Produce a unified diff plus the exact commands to verify. The tool surface is
   read-only, so the deliverable is a patch a human applies, never a claim that something shipped.
6. **Design QA (QA).** Run the checklist below at 390px, 768px and 1440px.
7. **Copy and claims (DOCS).** Every number traceable to a measurement or a live endpoint. No invented
   social proof, no benchmark we did not run, no "fastest".
8. **Release (ARCHITECT).** Preview deployment first, production only on the owner's word.

## Design QA checklist
- [ ] Contrast meets 4.5:1 for body text and 3:1 for large display type, in the shipped palette.
- [ ] Keyboard: every interactive element reachable, focus visible against the surface, no focus trap.
- [ ] 390px: no horizontal scrolling, no clipped table (tables scroll in a wrapper, never the page).
- [ ] Tap targets at least 44px on touch surfaces.
- [ ] Every list has an empty state and every async surface has a loading and an error state.
- [ ] Reduced motion respected for any transition over 120ms.
- [ ] No layout shift from late-loading fonts: display font preconnected, `display=swap`.
- [ ] Real content only. Placeholder lorem, fake logos and invented testimonials are defects.

## Standing rules
- Public pages are public by construction: they select from an allowlist, they do not filter a private set.
- Authenticated surfaces never render inside the public bundle; they are separate routes behind a session.
- A preview URL is not a release. Production changes only after the owner sees the preview.

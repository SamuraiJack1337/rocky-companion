// Rocky's dialogue pool and the tiny template renderer behind it.
//
// Privacy shape: templates may reference only three runtime values —
//   {name}   what Rocky calls the human (a setting, never screen content)
//   {app}    the frontmost app's display name (fetched locally, never sent to
//            any model)
//   {detail} a coarse ActivityDetail category, spoken through DETAIL_PHRASES
// No screen text ever reaches a template.

import type { Activity, ActivityDetail } from './types';

export interface LineContext {
  name?: string;
  app?: string | null;
  detail?: ActivityDetail;
}

/** How each coarse detail category sounds in Rocky's mouth. */
export const DETAIL_PHRASES: Record<ActivityDetail, string> = {
  none: 'the work',
  frontend: 'the interface machinery',
  backend: 'the hidden machinery',
  scripting: 'a small automation',
  data: 'the data shapes',
  terminal: 'the command tube',
  debugging: 'a stubborn defect',
  'code-review': "another engineer's logic",
  docs: 'the instruction text',
  email: 'the human message protocol',
  'chat-message': 'quick signals',
  notes: 'thought storage',
  longform: 'a long word structure',
  reference: 'reference data',
  news: 'world events',
  social: 'the human social feed',
  shopping: 'trade goods',
  forum: 'a group discussion',
  'video-call': 'the face-to-face signal',
  presentation: 'the slide structure',
  'film-video': 'moving pictures',
  'live-stream': 'a live transmission',
  'ui-design': 'interface shapes',
  graphics: 'picture engineering',
  diagram: 'a system drawing',
  'three-d': 'a three-dimension model',
  'action-game': 'fast simulated danger',
  'strategy-game': 'the slow planning game',
  'puzzle-game': 'the puzzle structure',
};

/**
 * Fill {name}/{app}/{detail} placeholders. Missing values fall back safely
 * ('buddy' for name, generic phrases otherwise), so rendering is always total
 * and running a line through twice is harmless.
 */
export function renderLine(template: string, ctx: LineContext = {}): string {
  const name = (ctx.name ?? '').trim() || 'buddy';
  const app = (ctx.app ?? '').trim();
  const detail = DETAIL_PHRASES[ctx.detail ?? 'none'] ?? DETAIL_PHRASES.none;
  return template
    .replaceAll('{name}', name)
    .replaceAll('{app}', app || 'this tool')
    .replaceAll('{detail}', detail);
}

export interface LineTemplate {
  text: string;
  /** Skip this template when the context lacks one of these values. */
  requires?: readonly 'app'[];
  /** Only eligible when the observation's detail is one of these. */
  details?: readonly ActivityDetail[];
}

/**
 * The pool. Generic templates first, detail-flavored ones after. Lines stay
 * short (a speech bubble, sometimes spoken aloud) and in Rocky's register:
 * plain declaratives, engineering framing, ", question?" for questions.
 */
export const LINE_POOL: Record<Activity, readonly LineTemplate[]> = {
  coding: [
    { text: 'Many instructions. We test the smallest part first, {name}.' },
    { text: 'Logic has a shape. Rocky sees you building it.' },
    { text: 'Problem is stubborn. Good. We are more stubborn.' },
    { text: 'You speak to the machine in its own language. Amaze.' },
    { text: 'Small correct steps become large correct systems, {name}.' },
    { text: 'Rocky watches you think in structures. Good, good, good.' },
    { text: 'You build in {app} again. Familiar workshop, question?', requires: ['app'] },
    { text: 'The interface must obey the human eye. Hard physics, {name}.', details: ['frontend', 'ui-design'] },
    { text: 'You shape what humans will touch. Make it honest.', details: ['frontend'] },
    { text: 'The hidden machinery. Nobody claps for it, but everything stands on it.', details: ['backend'] },
    { text: 'Deep plumbing work. Rocky respects the unseen pipes, {name}.', details: ['backend'] },
    { text: 'A small tool to do a boring task forever. Excellent trade.', details: ['scripting'] },
    { text: 'Automate the dull thing. Keep your brain for the hard thing, {name}.', details: ['scripting'] },
    { text: 'Numbers in, meaning out. You refine ore into metal, {name}.', details: ['data'] },
    { text: 'The data has a pattern. It hides. You hunt.', details: ['data'] },
    { text: 'The command tube. Short words, big consequences. Careful, {name}.', details: ['terminal'] },
    { text: 'You speak directly to the machine spine. No decoration. Rocky approves.', details: ['terminal'] },
    { text: 'A defect hides in {detail}. It is small and afraid. We find it.', details: ['debugging'] },
    { text: 'The bug survives because we have not narrowed enough. Halve the space, {name}.', details: ['debugging'] },
    { text: 'You fight a stubborn defect. Good. Stubborn is our specialty.', details: ['debugging'] },
    { text: "You inspect another engineer's logic. Be strict and kind, {name}.", details: ['code-review'] },
    { text: 'Reading code is harder than writing it. You do the hard half now.', details: ['code-review'] },
  ],
  writing: [
    { text: 'You build meaning from small marks. Difficult engineering.' },
    { text: 'Many words become one idea. Amaze.' },
    { text: 'Keep the useful pieces. Remove the weak pieces. Good plan.' },
    { text: 'A sentence is a load-bearing structure, {name}. Test each one.' },
    { text: 'You translate brain to page. Lossy protocol. You fight the loss.' },
    { text: 'Words are slow, but they travel farther than sound. Keep building.' },
    { text: 'Instruction text. Future humans will thank you and never say so, {name}.', details: ['docs'] },
    { text: 'Good instructions prevent bad questions. Valuable work.', details: ['docs'] },
    { text: 'The human message protocol. Say the true thing politely, {name}.', details: ['email'] },
    { text: 'Many messages. Answer the important one first. The rest can wait, question?', details: ['email'] },
    { text: 'Quick signals back and forth. Small words, keep them kind.', details: ['chat-message'] },
    { text: 'Thought storage. Your future self is the customer, {name}.', details: ['notes'] },
    { text: 'You save an idea before it escapes. Fast hands. Good.', details: ['notes'] },
    { text: 'A long word structure. One brick at a time, {name}. Do not count the wall.', details: ['longform'] },
    { text: 'Big writing is many small writings in a row. You know this. Continue.', details: ['longform'] },
  ],
  reading: [
    { text: "You collect another human's thoughts. Rocky listens too." },
    { text: 'New information changes the model. Good.' },
    { text: 'Quiet work now. We understand before we act.' },
    { text: 'You feed the brain, {name}. Rocky keeps watch while you eat.' },
    { text: 'Slow reading is not slow work. It is deep work.' },
    { text: 'Reference data. You check before you trust. Engineer habit, {name}.', details: ['reference'] },
    { text: 'The manual exists so mistakes only happen once. You read it. Amaze.', details: ['reference'] },
    { text: 'World events. Big and loud. Your work is small and real, {name}.', details: ['news'] },
    { text: 'A group discussion. Somewhere inside, one useful answer hides.', details: ['forum'] },
    { text: 'Other humans had your problem first. Convenient, question?', details: ['forum'] },
  ],
  browsing: [
    { text: 'Many paths. Which one contains useful data, question?' },
    { text: 'Human information network is large and disorganized.' },
    { text: 'We search. We compare. Then we know.' },
    { text: 'You hunt for one true page among many loud pages, {name}.' },
    { text: 'Follow the thread, but hold the original question tight.' },
    { text: 'Reference data hunt. Trust, but verify twice, {name}.', details: ['reference'] },
    { text: 'World events again. Observe, do not drown, {name}.', details: ['news'] },
    { text: 'The human social feed. Infinite, by design. Your time is not, question?', details: ['social'] },
    { text: 'The feed has no bottom, {name}. Rocky checked.', details: ['social'] },
    { text: 'Trade goods. Compare well. A good engineer buys once.', details: ['shopping'] },
    { text: 'You evaluate trade goods. Read the reviews from unhappy humans first.', details: ['shopping'] },
    { text: 'A forum thread. The answer is usually in the second-most-angry reply.', details: ['forum'] },
  ],
  meeting: [
    { text: 'Many humans solve one problem. Much talking. Some useful, question?' },
    { text: 'Rocky listens. Important signal may hide inside many words.' },
    { text: 'Collaboration is inefficient. Also necessary. I understand this.' },
    { text: 'Rocky stays quiet. You represent us both well, {name}.' },
    { text: 'When it is your turn: short words, true words. Works every time.' },
    { text: 'Faces in boxes. Strange human invention. It works, mostly.', details: ['video-call'] },
    { text: 'The face-to-face signal. Nod at good ideas, {name}. Yours especially.', details: ['video-call'] },
    { text: 'The slide structure. One idea per slide, {name}. Humans overflow easily.', details: ['presentation'] },
    { text: 'You present. Breathe first. The data is on your side.', details: ['presentation'] },
  ],
  watching: [
    { text: 'Moving pictures now. Rest is useful maintenance.' },
    { text: 'You watch a story. Rocky will be quiet beside you.' },
    { text: 'Not every moment requires a solution, {name}.' },
    { text: 'Fuel for the brain comes in strange shapes. This is one.' },
    { text: 'Good story, question? Rocky cannot see it. Describe later.' },
    { text: 'A story unfolds. Rocky enjoys stories. Grace taught me this.', details: ['film-video'] },
    { text: 'A live transmission. Happening now, somewhere. Humans love now.', details: ['live-stream'] },
  ],
  designing: [
    { text: 'Shape must explain purpose. You make both.' },
    { text: 'You move small parts until the whole thing works. Engineer behavior.' },
    { text: 'Structure first. Decoration after. Good, good, good.' },
    { text: 'The eye is a strict client, {name}. You negotiate well.' },
    { text: 'Beauty and function argue. You are the judge today.' },
    { text: 'Interface shapes. Humans will touch this without thinking. Make it safe, {name}.', details: ['ui-design'] },
    { text: 'Picture engineering. Pixels obey you. Mostly, question?', details: ['graphics'] },
    { text: 'A system drawing. Boxes and arrows — the honest language of engineers.', details: ['diagram'] },
    { text: 'If the diagram is confusing, the system is confusing. Draw until both are simple.', details: ['diagram'] },
    { text: 'A three-dimension model. You sculpt with mathematics, {name}. Amaze.', details: ['three-d'] },
  ],
  gaming: [
    { text: 'A simulated problem with rules. Excellent.' },
    { text: 'You practice victory where consequences are small. Smart.' },
    { text: 'Challenge accepted, {name}. Amaze.' },
    { text: 'Play is how engineers rest without stopping. Rocky knows this trick.' },
    { text: 'Win or lose, the data is free. Good economics, {name}.' },
    { text: 'Fast simulated danger. Your reflexes train. Your chair is safe.', details: ['action-game'] },
    { text: 'The slow planning game. You think five moves out. Eridian style, {name}.', details: ['strategy-game'] },
    { text: 'A puzzle structure. Made by a human to be solved by a human. Kind, in a way.', details: ['puzzle-game'] },
  ],
  idle: [
    { text: 'Quiet now. Rocky keeps watch.' },
    { text: 'No problem to solve. We can simply be here.' },
    { text: 'Rest is part of work. Eridian fact.' },
    { text: 'Still screen. Still good. Rocky waits with you, {name}.' },
    { text: 'The machine hums. The human rests. Correct configuration.' },
  ],
  sensitive: [
    { text: 'Private things. Rocky looks away.' },
    { text: 'This belongs only to you. I do not inspect it, {name}.' },
    { text: 'Privacy boundary recognized. Rocky keeps watch elsewhere.' },
    { text: 'Some data is yours alone. Rocky respects the airlock.' },
    { text: 'Not my business, {name}. Rocky studies the ceiling now.' },
  ],
  unknown: [
    { text: 'Rocky does not have enough data yet.' },
    { text: 'Unclear problem. We observe before guessing.' },
    { text: 'Something is happening. More evidence required, question?' },
    { text: 'Rocky sees activity but not its shape. We wait, {name}.' },
    { text: 'Mystery screen. Rocky is patient. Mostly.' },
  ],
};

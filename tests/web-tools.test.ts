import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDuckDuckGoHtml,
  extractReadableText,
  isFetchableUrl,
  parseToolArgs,
  displayHost,
  startResearchTopicFromOpenAIOutput,
  startResearchTopicFromToolCalls,
  PAGE_TEXT_MAX_LENGTH,
} from '../src/main/webTools';

// A trimmed fixture in DDG's html-endpoint shape: two results, one redirect
// link and one snippet, plus an entity to decode.
const DDG_FIXTURE = `
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha&rut=x">Alpha &amp; Beta</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha is a <b>thing</b> worth reading.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fbeta">Beta Guide</a>
  <a class="result__snippet" href="#">A guide to beta.</a>
</div>
`;

test('parseDuckDuckGoHtml unwraps redirect urls and decodes titles', () => {
  const hits = parseDuckDuckGoHtml(DDG_FIXTURE, 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, 'https://example.com/alpha');
  assert.equal(hits[0].title, 'Alpha & Beta');
  assert.ok(hits[0].snippet.includes('worth reading'));
  assert.equal(hits[1].url, 'https://example.org/beta');
});

test('parseDuckDuckGoHtml respects the max and returns [] for junk', () => {
  assert.equal(parseDuckDuckGoHtml(DDG_FIXTURE, 1).length, 1);
  assert.deepEqual(parseDuckDuckGoHtml('<html>no results here</html>'), []);
  assert.deepEqual(parseDuckDuckGoHtml(''), []);
});

test('extractReadableText strips scripts/tags and clamps length', () => {
  const html =
    '<html><head><style>.x{color:red}</style></head><body>' +
    '<script>evil()</script><h1>Title</h1><p>Hello &amp; welcome.</p></body></html>';
  const text = extractReadableText(html);
  assert.ok(text.includes('Title'));
  assert.ok(text.includes('Hello & welcome.'));
  assert.ok(!text.includes('evil'));
  assert.ok(!text.includes('color:red'));

  const huge = `<p>${'word '.repeat(5000)}</p>`;
  assert.ok(extractReadableText(huge).length <= PAGE_TEXT_MAX_LENGTH);
});

test('isFetchableUrl allows only http(s)', () => {
  assert.ok(isFetchableUrl('https://example.com'));
  assert.ok(isFetchableUrl('http://example.com/x'));
  assert.ok(!isFetchableUrl('file:///etc/passwd'));
  assert.ok(!isFetchableUrl('javascript:alert(1)'));
  assert.ok(!isFetchableUrl('not a url'));
});

test('parseToolArgs tolerates objects, JSON strings, and garbage', () => {
  assert.deepEqual(parseToolArgs({ query: 'x' }), { query: 'x' });
  assert.deepEqual(parseToolArgs('{"url":"https://a.b"}'), { url: 'https://a.b' });
  assert.deepEqual(parseToolArgs('not json'), {});
  assert.deepEqual(parseToolArgs(42), {});
  assert.deepEqual(parseToolArgs(['a']), {});
});

test('displayHost shows the bare host', () => {
  assert.equal(displayHost('https://www.example.com/deep/path'), 'example.com');
  assert.equal(displayHost('garbage'), 'a page');
});

// ── start_research sentinel harvesting (Layer 2 intent routing) ──────────────

test('startResearchTopicFromToolCalls finds the topic in an Ollama tool_calls array', () => {
  const calls = [
    { function: { name: 'search_web', arguments: { query: 'x' } } },
    { function: { name: 'start_research', arguments: '{"topic":"  kokoro tts voices "}' } },
  ];
  assert.equal(startResearchTopicFromToolCalls(calls), 'kokoro tts voices');
  // Object-shaped arguments work too.
  assert.equal(
    startResearchTopicFromToolCalls([
      { function: { name: 'start_research', arguments: { topic: 'pgvector' } } },
    ]),
    'pgvector',
  );
});

test('startResearchTopicFromToolCalls is null without a usable call', () => {
  assert.equal(startResearchTopicFromToolCalls([]), null);
  assert.equal(startResearchTopicFromToolCalls(undefined), null);
  assert.equal(
    startResearchTopicFromToolCalls([{ function: { name: 'search_web', arguments: {} } }]),
    null,
  );
  // A start_research call with garbage/empty arguments routes nothing.
  assert.equal(
    startResearchTopicFromToolCalls([{ function: { name: 'start_research', arguments: 'junk' } }]),
    null,
  );
  assert.equal(
    startResearchTopicFromToolCalls([
      { function: { name: 'start_research', arguments: { topic: '   ' } } },
    ]),
    null,
  );
});

test('startResearchTopicFromOpenAIOutput finds the function_call item', () => {
  const output = [
    { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
    { type: 'function_call', name: 'start_research', arguments: '{"topic":"webgpu support"}' },
  ];
  assert.equal(startResearchTopicFromOpenAIOutput(output), 'webgpu support');
});

test('startResearchTopicFromOpenAIOutput is null for plain answers', () => {
  assert.equal(
    startResearchTopicFromOpenAIOutput([
      { type: 'message', content: [{ type: 'output_text', text: 'just an answer' }] },
    ]),
    null,
  );
  assert.equal(startResearchTopicFromOpenAIOutput(undefined), null);
  assert.equal(
    startResearchTopicFromOpenAIOutput([
      { type: 'function_call', name: 'other_tool', arguments: '{"topic":"x"}' },
    ]),
    null,
  );
});

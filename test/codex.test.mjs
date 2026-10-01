import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('Codex execution reports only validated final usage from JSON events', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-codex-usage-'));
  const binary = join(directory, 'codex-stub');
  await writeFile(binary, `#!${process.execPath}
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  const request = JSON.parse(prompt);
  process.stderr.write('PRIVATE_RUNTIME_DIAGNOSTIC');
  const events = request.echoArgs ? [{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(process.argv.slice(2))}}] : request.events;
  const output = events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\\n');
  const split = Math.floor(output.length / 2);
  process.stdout.write(output.slice(0, split));
  setImmediate(() => { process.stdout.write(output.slice(split)); process.exitCode = request.exitCode || 0; });
});
`, { mode: 0o700 });
  const previousBinary = process.env.FUORI_STUDIO_CODEX_BIN, previousDirectory = process.env.FUORI_STUDIO_DATA_DIR;
  process.env.FUORI_STUDIO_CODEX_BIN = binary;
  process.env.FUORI_STUDIO_DATA_DIR = directory;
  const { runCodex, runCodexResult, shutdownCodex } = await import(`../lib/codex.mjs?fixture=${randomUUID()}`);
  t.after(async () => {
    shutdownCodex();
    if (previousBinary === undefined) delete process.env.FUORI_STUDIO_CODEX_BIN; else process.env.FUORI_STUDIO_CODEX_BIN = previousBinary;
    if (previousDirectory === undefined) delete process.env.FUORI_STUDIO_DATA_DIR; else process.env.FUORI_STUDIO_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  const answer = { type: 'item.completed', item: { type: 'agent_message', text: 'Risposta verificata.' } };
  const execute = (events, more = {}, options = {}) => runCodexResult(JSON.stringify({ events, ...more }), options);

  await t.test('captures final event without a newline and ignores diagnostic, cached and reasoning metadata', async () => {
    const result = await execute([
      'PRIVATE_NON_JSON_DIAGNOSTIC',
      { type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_REASONING' } },
      answer,
      { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0, diagnostic: 'PRIVATE_USAGE_METADATA' } },
    ]);
    assert.deepEqual(result, { text: 'Risposta verificata.', usage: { inputTokens: 24763, outputTokens: 122 } });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  });

  await t.test('old text API and CLI versions without usage remain compatible', async () => {
    assert.equal(await runCodex(JSON.stringify({ events: [answer] })), 'Risposta verificata.');
    assert.deepEqual((await execute([answer])).usage, { inputTokens: null, outputTokens: null });
    assert.deepEqual((await execute([answer, { type: 'turn.started', usage: { input_tokens: 99, output_tokens: 99 } }])).usage, { inputTokens: null, outputTokens: null });
  });

  await t.test('counts are independent, safe nonnegative integers and zero is a real measurement', async () => {
    for (const value of [-1, 1.5, '12', true, {}, null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual((await execute([answer, { type: 'turn.completed', usage: { input_tokens: value, output_tokens: 0 } }])).usage, { inputTokens: null, outputTokens: 0 });
      assert.deepEqual((await execute([answer, { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: value } }])).usage, { inputTokens: 0, outputTokens: null });
    }
    for (const usage of [undefined, null, [], 'PRIVATE_INVALID_USAGE']) {
      assert.deepEqual((await execute([answer, { type: 'turn.completed', usage }])).usage, { inputTokens: null, outputTokens: null });
    }
  });

  await t.test('usage cannot turn failed execution or missing assistant output into success', async () => {
    const completed = { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } };
    await assert.rejects(execute([completed]), error => !error.message.includes('PRIVATE_') && /non ha restituito/.test(error.message));
    await assert.rejects(execute([answer, completed], { exitCode: 1 }), error => !error.message.includes('PRIVATE_') && /non ha restituito/.test(error.message));
  });

  await t.test('input-only mode applies explicit tool controls without changing the ordinary runner', async () => {
    const ordinary = JSON.parse((await execute([], { echoArgs: true })).text);
    assert.equal(ordinary.includes('--strict-config'), false); assert.equal(ordinary.includes('--disable'), false);
    const args = JSON.parse((await execute([], { echoArgs: true }, { inputOnly: true })).text);
    for (const flag of ['--ignore-user-config', '--ephemeral', '--strict-config', '--ignore-rules']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    const disabled = args.flatMap((value, index) => value === '--disable' ? [args[index + 1]] : []);
    for (const feature of ['shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'multi_agent_v2', 'agent_message_board', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'view_image', 'artifact', 'workspace_dependencies', 'code_mode', 'code_mode_host', 'code_mode_only', 'code_mode_prewarm', 'memories', 'external_agent_memory_import', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'goals', 'request_permissions_tool', 'standalone_web_search', 'sleep_tool']) assert.ok(disabled.includes(feature), feature);
    assert.equal(args[args.indexOf('--enable') + 1], 'skip_host_skill_discovery');
    const settings = args.flatMap((value, index) => value === '-c' ? [args[index + 1]] : []);
    for (const setting of ['web_search="disabled"', 'tools.view_image=false', 'project_doc_max_bytes=0', 'mcp_servers={}', 'plugins={}', 'approval_policy="never"', 'allow_login_shell=false']) assert.ok(settings.includes(setting), setting);
    assert.equal(args.at(-1), '-');
    for (const inputOnly of [null, 'true', 1, {}]) await assert.rejects(execute([answer], {}, { inputOnly }), /modalità/);
  });

  await t.test('input-only parsing rejects command, tool, web, filesystem, collaboration and unknown activity', async () => {
    const items = ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'collab_tool_call', 'browser_tool_call', 'computer_tool_call', 'image_generation', 'todo_list', 'future_tool'];
    for (const type of items) {
      const event = { type: 'item.started', item: { type, command: 'PRIVATE_COMMAND', arguments: 'PRIVATE_SECRET', text: 'PRIVATE_TOOL_OUTPUT' } };
      await assert.rejects(execute([event, answer], {}, { inputOnly: true }), error => error.code === 'CODEX_INPUT_ONLY_ACTIVITY' && !error.message.includes('PRIVATE_'));
    }
    for (const event of [{ type: 'item.updated', item: { type: 'command_execution' } }, { type: 'item.completed', item: { type: 'mcp_tool_call' } }, { type: 'tool.started' }, { type: 'unknown.event' }, null, 'PRIVATE_NON_JSON']) {
      await assert.rejects(execute([answer, event], {}, { inputOnly: true }), error => error.code === 'CODEX_INPUT_ONLY_ACTIVITY' && !error.message.includes('PRIVATE_'));
    }
    const result = await execute([{ type: 'thread.started', thread_id: 'not-exposed' }, { type: 'turn.started' }, { type: 'item.started', item: { type: 'reasoning' } }, answer, { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }], {}, { inputOnly: true });
    assert.deepEqual(result, { text: 'Risposta verificata.', usage: { inputTokens: 12, outputTokens: 4 } });
    assert.equal((await execute([{ type: 'item.completed', item: { type: 'command_execution' } }, answer])).text, 'Risposta verificata.', 'ordinary execution retains its previous event handling');
  });
});

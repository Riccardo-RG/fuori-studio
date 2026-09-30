import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';

const delay=ms=>new Promise(done=>setTimeout(done,ms));
test('duplicate shutdown signals finish archive cleanup, remove the instance lock and permit restart',{timeout:15000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'fuori-shutdown-http-')),children=[];
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(done=>reserve.close(done));
  t.after(async()=>{
    for(const child of children){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await child.exited;}
    await rm(directory,{recursive:true,force:true});
  });
  // Hold the real archive close at an asynchronous boundary. The IPC handshake
  // guarantees the repeated signal arrives after the first handler has started.
  const fixture=`
    import {defaultArchive} from './lib/archive.mjs';
    const close=defaultArchive.close;
    defaultArchive.close=async()=>{
      const released=new Promise(done=>process.once('message',done));
      process.send({type:'closing'});
      await released;
      return close();
    };
    await import('./server.mjs');
  `;
  for(const signal of ['SIGINT','SIGTERM']){
    const child=spawn(process.execPath,['--input-type=module','--eval',fixture],{cwd:resolve('.'),env:{...process.env,PORT:String(port),FUORI_STUDIO_MODE:'local',FUORI_STUDIO_BIND:'127.0.0.1',FUORI_STUDIO_PUBLIC_URL:`http://127.0.0.1:${port}`,FUORI_STUDIO_DATA_DIR:directory,FUORI_STUDIO_CODEX_BIN:join(directory,'intentionally-unavailable-codex')},stdio:['ignore','pipe','pipe','ipc']});
    children.push(child);child.exited=once(child,'exit');
    let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
    for(let attempt=0;!output.includes('Fuori Studio')&&attempt<200;attempt++){
      assert.equal(child.exitCode,null,errors);assert.equal(child.signalCode,null,errors);await delay(10);
    }
    assert.match(output,/Fuori Studio/,errors);
    assert.equal(JSON.parse(await readFile(join(directory,'server.lock'),'utf8')).pid,child.pid);
    const closing=once(child,'message');child.kill(signal);
    assert.deepEqual((await closing)[0],{type:'closing'});
    child.kill(signal);await delay(30);
    assert.equal(child.signalCode,null,`duplicate ${signal} must not interrupt cleanup`);
    assert.equal(child.exitCode,null,'cleanup remains pending until the archive is released');
    child.send({type:'release'});
    assert.deepEqual(await child.exited,[0,null],errors);
    await assert.rejects(readFile(join(directory,'server.lock')),{code:'ENOENT'});
    // The next iteration starts against this same archive and port.
  }
});

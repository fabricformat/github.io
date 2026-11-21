import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const file = await readFile(new URL('./public-chat.mjs', import.meta.url), 'utf8');
const endpoint = 'https://example.com/api/chat';

function harness(mock) {
  const els = Object.fromEntries(['#ask','#question','#send','#status','#result','#answer']
    .map(key => [key, {textContent:'',value:'',hidden:false,disabled:false,addEventListener(_,fn){this.submit=fn;}}]));
  vm.runInNewContext(file.replace('__WORKER_ENDPOINT__', endpoint), {
    document:{querySelector(k){return els[k];}}, fetch:mock, AbortSignal,
  });
  els['#question'].value='  你好  ';
  return {els,submit:()=>els['#ask'].submit({preventDefault(){}})};
}

test('anonymous request sends only trimmed text and renders answer as text',async()=>{
  const h=harness(async(url, options)=>{
    assert.equal(url,endpoint);
    assert.equal(options.credentials,'omit');
    assert.deepEqual(Object.keys(options.headers),['Content-Type']);
    assert.deepEqual(JSON.parse(options.body),{message:'你好'});
    return new Response(JSON.stringify({answer:'<b>示例</b>'}));
  });
  await h.submit();
  assert.equal(h.els['#answer'].textContent,'<b>示例</b>');
  assert.equal(h.els['#result'].hidden,false);
  assert.equal(h.els['#send'].disabled,false);
});

test('quota and upstream failure show no hidden response content',async()=>{
  let response = new Response('private diagnostics',{status:429});
  const h=harness(async()=>response);
  await h.submit();
  assert.match(h.els['#status'].textContent,/上限/);
  response = new Response('private diagnostics',{status:502});
  await h.submit();
  assert.match(h.els['#status'].textContent,/暂时/);
  assert.equal(h.els['#answer'].textContent,'');
  assert.equal(h.els['#result'].hidden,true);
});

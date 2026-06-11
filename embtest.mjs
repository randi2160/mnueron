const t0=Date.now();
const { pipeline, env } = await import('@xenova/transformers');
env.allowRemoteModels = true;
const p = await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{quantized:true});
console.log('model load ms:', Date.now()-t0);
const chunk = 'lorem ipsum dolor sit amet consectetur '.repeat(110).slice(0,4000);
for (const N of [8, 32, 128]) {
  const arr = Array.from({length:N}, ()=>chunk);
  const s=Date.now();
  await p(arr,{pooling:'mean',normalize:true});
  const d=Date.now()-s;
  console.log(`batch N=${N}: ${d} ms  (${(d/N).toFixed(0)} ms/chunk)`);
}

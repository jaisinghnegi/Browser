import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const schema = JSON.parse(await readFile(new URL('../shared/protocol.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ code: { source: true, esm: true } });
ajv.addSchema(schema);
const code = standaloneCode(ajv, {
  requestValid: 'urn:privacy-agent:protocol#/definitions/request',
  actionValid: 'urn:privacy-agent:protocol#/definitions/action',
});
await mkdir(new URL('../extension/generated/', import.meta.url), { recursive: true });
await writeFile(new URL('../extension/generated/validators.js', import.meta.url), code);

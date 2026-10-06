// Takes the place of the MCP SDK's default JSON Schema validator in the plugin bundle. The default, ajv, compiles
// each schema to JavaScript with `new Function`. This validator, from the same SDK, interprets the schema instead.
export { CfWorkerJsonSchemaValidator as AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

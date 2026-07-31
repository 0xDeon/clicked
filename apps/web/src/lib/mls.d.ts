declare module '@openmls/wasm' {
  const initialize: (() => Promise<unknown> | unknown) | undefined;
  export default initialize;
  export function init(): Promise<unknown> | unknown;
  export class Client {
    constructor(...args: unknown[]);
  }
  export class MlsClient {
    constructor(...args: unknown[]);
  }
  export class WasmClient {
    constructor(...args: unknown[]);
  }
}

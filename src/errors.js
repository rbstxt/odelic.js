/** Error types. `InputError` = bad user input (HTTP 400); the others come from the mesh / BLE side. */

export class OdelicError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** Invalid argument: unknown light name, malformed vaddr / ID, out-of-range number, ... */
export class InputError extends OdelicError {}

/** The node rejected the login (wrong HomeID / password, or another controller is connected). */
export class LoginError extends OdelicError {}

/** No mesh node found, or the BLE link could not be established. */
export class ConnectionError extends OdelicError {}

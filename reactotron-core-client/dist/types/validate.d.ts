import { ClientOptions } from './client-options';
/**
 * Ensures the options are sane to run this baby.  Throw if not.  These
 * are basically sanity checks.
 */
declare const validate: (options: ClientOptions) => void;
export default validate;

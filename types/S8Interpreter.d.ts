declare module '*S8Interpreter' {
    export class S8Interpreter {
        /**
         * Create a new interpreter.
         * @param {string} code Raw JavaScript text.
         * @param {Function=} initFunc Optional initialization function.  Used to
         *     define APIs.  When called it is passed the interpreter object and the
         *     global scope object.
         * @constructor
         */
        constructor(code: string, initFunc?: (interpreter: S8Interpreter, scope: any) => void);
        /**
         * Execute the interpreter to program completion.  Vulnerable to infinite loops.
         * @return {boolean} True if a execution is asynchronously blocked,
         *     false if no more instructions.
         */
        run(): void;
    }
}

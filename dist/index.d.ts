export = S8Interpreter;

declare namespace S8Interpreter {
    type InterpreterValue = InterpreterObject | boolean | number | string | undefined | null;
    type InterpreterScope = {
        parentScope: InterpreterScope | null;
        strict: boolean;
        object: InterpreterObject | null;
    };
    type InterpreterState = {
        scope: InterpreterScope;
        node: InterpreterObject;
    };
    type InterpreterObject = {
        proto: InterpreterObject | null;
        class: string;
        data: Date | RegExp | boolean | number | string | null;
        getter: any;
        setter: any;
        properties: any;
        /**
         * Convert this object into a string.
         * @return {string} String value.
         * @override
         */
        toString: () => string;
        /**
         * Return the object's value.
         * @return {InterpreterValue} Value.
         * @override
         */
        valueOf: () => InterpreterValue;
    };
    type InterpreterCompletion = {
        NORMAL: 0;
        BREAK: 1;
        CONTINUE: 2;
        RETURN: 3;
        THROW: 4;
    };
    class Interpreter {
        /**
         * Create a new interpreter.
         * @param {string|!InterpreterObject} code Raw JavaScript text.
         * @param {Function=} initFunc Optional initialization function.  Used to
         *     define APIs.  When called it is passed the interpreter object and the
         *     global scope object.
         * @constructor
         */
        constructor(
            code: string | InterpreterObject,
            initFunc?: (interpreter: Interpreter, scope: InterpreterObject) => void,
        );

        /**
         * Add more code to the interpreter.
         * @param {string|!InterpreterObject} code Raw JavaScript text or AST.
         */
        appendCode(code: string | InterpreterObject): void;

        /**
         * Execute the interpreter to program completion.  Vulnerable to infinite loops.
         * @return {boolean} True if a execution is asynchronously blocked,
         *     false if no more instructions.
         */
        run(): boolean;

        /**
         * Execute one step of the interpreter.
         * @return {boolean} True if a step was executed, false if no more instructions.
         */
        step(): boolean;

        /**
         * Unwind the stack to the innermost relevant enclosing TryStatement,
         * For/ForIn/WhileStatement or Call/NewExpression.  If this results in
         * the stack being completely unwound the thread will be terminated
         * and the appropriate error being thrown.
         * @param {InterpreterCompletion} type Completion type.
         * @param {InterpreterValue} value Value computed, returned or thrown.
         * @param {string|undefined} label Target label for break or return.
         */
        unwind(type: InterpreterCompletion, value: InterpreterValue, label?: string): void;

        /**
         * Set a timeout for regular expression threads.  Unless cancelled, this will
         * terminate the thread and throw an error.
         * @param {!RegExp} nativeRegExp Regular expression (used for error message).
         * @param {!Worker} worker Thread to terminate.
         * @param {!Function} callback Async callback function to continue execution.
         * @return {number} PID of timeout.  Used to cancel if thread completes.
         */
        regExpTimeout(nativeRegExp: RegExp, worker: Worker, callback: () => void): number;

        /**
         * Create a new native function.
         * @param {!Function} nativeFunc JavaScript function.
         * @param {boolean} isConstructor True if function can be used with 'new'.
         * @return {!InterpreterObject} New function.
         */
        createNativeFunction(nativeFunc: any, isConstructor?: boolean): InterpreterObject;

        /**
         * Create a new native asynchronous function.
         * @param {!Function} asyncFunc JavaScript function.
         * @return {!InterpreterObject} New function.
         */
        createAsyncFunction(asyncFunc: any): InterpreterObject;
    }
}

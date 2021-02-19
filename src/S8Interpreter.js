/**
 * @license
 * Copyright 2013 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Interpreting JavaScript in JavaScript.
 * @author fraser@google.com (Neil Fraser)
 */
'use strict';

import { s8Acorn as acorn } from './acorn';

/**
 * Create a new interpreter.
 * @param {string|!Object} code Raw JavaScript text or AST.
 * @param {Function=} opt_initFunc Optional initialization function.  Used to
 *     define APIs.  When called it is passed the interpreter object and the
 *     global scope object.
 * @constructor
 */
const S8Interpreter = function(code, opt_initFunc) {
    if (typeof code === 'string') {
        code = acorn.parse(code, S8Interpreter.PARSE_OPTIONS);
    }
    // Get a handle on Acorn's node_t object.
    this.nodeConstructor = code.constructor;
    // Clone the root 'Program' node so that the AST may be modified.
    const ast = new this.nodeConstructor({ options: {} });
    for (let prop in code) {
        ast[prop] = (prop === 'body') ? code[prop].slice() : code[prop];
    }
    this.ast = ast;
    this.initFunc_ = opt_initFunc;
    this.paused_ = false;
    this.polyfills_ = [];
    // Unique identifier for native functions.  Used in serialization.
    this.functionCounter_ = 0;
    // Map node types to our step function names; a property lookup is faster
    // than string concatenation with "step" prefix.
    this.stepFunctions_ = Object.create(null);
    const stepMatch = /^step([A-Z]\w*)$/;
    let m;
    for (let methodName in this) {
        if ((typeof this[methodName] === 'function') &&
            (m = methodName.match(stepMatch))) {
            this.stepFunctions_[m[1]] = this[methodName].bind(this);
        }
    }
    // Create and initialize the global scope.
    this.globalScope = this.createScope(this.ast, null);
    this.globalObject = this.globalScope.object;
    // Run the polyfills.
    this.ast = acorn.parse(this.polyfills_.join('\n'), S8Interpreter.PARSE_OPTIONS);
    this.polyfills_ = undefined;  // Allow polyfill strings to garbage collect.
    S8Interpreter.stripLocations_(this.ast, undefined, undefined);
    let state = new S8Interpreter.State(this.ast, this.globalScope);
    state.done = false;
    this.stateStack = [state];
    this.run();
    this.value = undefined;
    // Point at the main program.
    this.ast = ast;
    state = new S8Interpreter.State(this.ast, this.globalScope);
    state.done = false;
    this.stateStack.length = 0;
    this.stateStack[0] = state;
    // Preserve publicly properties from being pruned/renamed by JS compilers.
    // Add others as needed.
    this['stateStack'] = this.stateStack;
};

/**
 * Completion Value Types.
 * @enum {number}
 */
S8Interpreter.Completion = {
    NORMAL: 0,
    BREAK: 1,
    CONTINUE: 2,
    RETURN: 3,
    THROW: 4,
};

/**
 * @const {!Object} Configuration used for all Acorn parsing.
 */
S8Interpreter.PARSE_OPTIONS = {
    ecmaVersion: 5,
};

/**
 * Property descriptor of readonly properties.
 */
S8Interpreter.READONLY_DESCRIPTOR = {
    configurable: true,
    enumerable: true,
    writable: false,
};

/**
 * Property descriptor of non-enumerable properties.
 */
S8Interpreter.NONENUMERABLE_DESCRIPTOR = {
    configurable: true,
    enumerable: false,
    writable: true,
};

/**
 * Property descriptor of readonly, non-enumerable properties.
 */
S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR = {
    configurable: true,
    enumerable: false,
    writable: false,
};

/**
 * Property descriptor of variables.
 */
S8Interpreter.VARIABLE_DESCRIPTOR = {
    configurable: false,
    enumerable: true,
    writable: true,
};

/**
 * Unique symbol for indicating that a step has encountered an error, has
 * added it to the stack, and will be thrown within the user's program.
 * When STEP_ERROR is thrown in the JS-Interpreter, the error can be ignored.
 */
S8Interpreter.STEP_ERROR = { 'STEP_ERROR': true };

/**
 * Unique symbol for indicating that a reference is a variable on the scope,
 * not an object property.
 */
S8Interpreter.SCOPE_REFERENCE = { 'SCOPE_REFERENCE': true };

/**
 * Unique symbol for indicating, when used as the value of the value
 * parameter in calls to setProperty and friends, that the value
 * should be taken from the property descriptor instead.
 */
S8Interpreter.VALUE_IN_DESCRIPTOR = { 'VALUE_IN_DESCRIPTOR': true };

/**
 * Unique symbol for indicating that a RegExp timeout has occurred in a VM.
 */
S8Interpreter.REGEXP_TIMEOUT = { 'REGEXP_TIMEOUT': true };

/**
 * For cycle detection in array to string and error conversion;
 * see spec bug github.com/tc39/ecma262/issues/289
 * Since this is for atomic actions only, it can be a class property.
 */
S8Interpreter.toStringCycles_ = [];

/**
 * Node's vm module, if loaded and required.
 * @type {Object}
 */
S8Interpreter.vm = null;

/**
 * Code for executing regular expressions in a thread.
 */
S8Interpreter.WORKER_CODE = [
    'onmessage = function(e) {',
    'var result;',
    'var data = e.data;',
    'switch (data[0]) {',
    'case \'split\':',
    // ['split', string, separator, limit]
    'result = data[1].split(data[2], data[3]);',
    'break;',
    'case \'match\':',
    // ['match', string, regexp]
    'result = data[1].match(data[2]);',
    'break;',
    'case \'search\':',
    // ['search', string, regexp]
    'result = data[1].search(data[2]);',
    'break;',
    'case \'replace\':',
    // ['replace', string, regexp, newSubstr]
    'result = data[1].replace(data[2], data[3]);',
    'break;',
    'case \'exec\':',
    // ['exec', regexp, lastIndex, string]
    'var regexp = data[1];',
    'regexp.lastIndex = data[2];',
    'result = [regexp.exec(data[3]), data[1].lastIndex];',
    'break;',
    'default:',
    'throw Error(\'Unknown RegExp operation: \' + data[0]);',
    '}',
    'postMessage(result);',
    '};'];

/**
 * Is a value a legal integer for an array length?
 * @param {S8Interpreter.Value} x Value to check.
 * @return {number} Zero, or a positive integer if the value can be
 *     converted to such.  NaN otherwise.
 */
S8Interpreter.legalArrayLength = function(x) {
    const n = x >>> 0;
    // Array length must be between 0 and 2^32-1 (inclusive).
    return (n === Number(x)) ? n : NaN;
};

/**
 * Is a value a legal integer for an array index?
 * @param {S8Interpreter.Value} x Value to check.
 * @return {number} Zero, or a positive integer if the value can be
 *     converted to such.  NaN otherwise.
 */
S8Interpreter.legalArrayIndex = function(x) {
    const n = x >>> 0;
    // Array index cannot be 2^32-1, otherwise length would be 2^32.
    // 0xffffffff is 2^32-1.
    return (String(n) === String(x) && n !== 0xffffffff) ? n : NaN;
};

/**
 * Remove start and end values from AST, or set start and end values to a
 * constant value.  Used to remove highlighting from polyfills and to set
 * highlighting in an eval to cover the entire eval expression.
 * @param {!Object} node AST node.
 * @param {number=} start Starting character of all nodes, or undefined.
 * @param {number=} end Ending character of all nodes, or undefined.
 * @private
 */
S8Interpreter.stripLocations_ = function(node, start, end) {
    if (start) {
        node['start'] = start;
    } else {
        delete node['start'];
    }
    if (end) {
        node['end'] = end;
    } else {
        delete node['end'];
    }
    for (let name in node) {
        if (node.hasOwnProperty(name)) {
            const prop = node[name];
            if (prop && typeof prop === 'object') {
                S8Interpreter.stripLocations_(prop, start, end);
            }
        }
    }
};

/**
 * Some pathological regular expressions can take geometric time.
 * Regular expressions are handled in one of three ways:
 * 0 - throw as invalid.
 * 1 - execute natively (risk of unresponsive program).
 * 2 - execute in separate thread (not supported by IE 9).
 */
S8Interpreter.prototype['REGEXP_MODE'] = 2;

/**
 * If REGEXP_MODE = 2, the length of time (in ms) to allow a RegExp
 * thread to execute before terminating it.
 */
S8Interpreter.prototype['REGEXP_THREAD_TIMEOUT'] = 1000;

/**
 * Flag indicating that a getter function needs to be called immediately.
 * @private
 */
S8Interpreter.prototype.getterStep_ = false;

/**
 * Flag indicating that a setter function needs to be called immediately.
 * @private
 */
S8Interpreter.prototype.setterStep_ = false;

/**
 * Add more code to the interpreter.
 * @param {string|!Object} code Raw JavaScript text or AST.
 */
S8Interpreter.prototype.appendCode = function(code) {
    const state = this.stateStack[0];
    if (!state || state.node['type'] !== 'Program') {
        throw Error('Expecting original AST to start with a Program node.');
    }
    if (typeof code === 'string') {
        code = acorn.parse(code, S8Interpreter.PARSE_OPTIONS);
    }
    if (!code || code['type'] !== 'Program') {
        throw Error('Expecting new AST to start with a Program node.');
    }
    this.populateScope_(code, state.scope);
    // Append the new program to the old one.
    Array.prototype.push.apply(state.node['body'], code['body']);
    state.done = false;
};

/**
 * Execute one step of the interpreter.
 * @return {boolean} True if a step was executed, false if no more instructions.
 */
S8Interpreter.prototype.step = function() {
    const stack = this.stateStack;
    do {
        const state = stack[stack.length - 1];
        if (!state) {
            return false;
        }
        var node = state.node, type = node['type'];
        if (type === 'Program' && state.done) {
            return false;
        } else if (this.paused_) {
            return true;
        }
        try {
            var nextState = this.stepFunctions_[type](stack, state, node);
        } catch (e) {
            // Eat any step errors.  They have been thrown on the stack.
            if (e !== S8Interpreter.STEP_ERROR) {
                // Uh oh.  This is a real error in the JS-Interpreter.  Rethrow.
                throw e;
            }
        }
        if (nextState) {
            stack.push(nextState);
        }
        if (this.getterStep_) {
            // Getter from this step was not handled.
            throw Error('Getter not supported in this context');
        }
        if (this.setterStep_) {
            // Setter from this step was not handled.
            throw Error('Setter not supported in this context');
        }
        // This may be polyfill code.  Keep executing until we arrive at user code.
    } while (!node['end']);
    return true;
};

/**
 * Execute the interpreter to program completion.  Vulnerable to infinite loops.
 * @return {boolean} True if a execution is asynchronously blocked,
 *     false if no more instructions.
 */
S8Interpreter.prototype.run = function() {
    while (!this.paused_ && this.step()) {
    }
    return this.paused_;
};

/**
 * Initialize the global object with buitin properties and functions.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initGlobal = function(globalObject) {
    // Initialize uneditable global properties.
    this.setProperty(globalObject, 'NaN', NaN,
        S8Interpreter.READONLY_DESCRIPTOR);
    this.setProperty(globalObject, 'Infinity', Infinity,
        S8Interpreter.READONLY_DESCRIPTOR);
    this.setProperty(globalObject, 'undefined', undefined,
        S8Interpreter.READONLY_DESCRIPTOR);
    this.setProperty(globalObject, 'window', globalObject,
        S8Interpreter.READONLY_DESCRIPTOR);
    this.setProperty(globalObject, 'this', globalObject,
        S8Interpreter.READONLY_DESCRIPTOR);
    this.setProperty(globalObject, 'self', globalObject);  // Editable.

    // Create the objects which will become Object.prototype and
    // Function.prototype, which are needed to bootstrap everything else.
    this.OBJECT_PROTO = new S8Interpreter.Object(null);
    this.FUNCTION_PROTO = new S8Interpreter.Object(this.OBJECT_PROTO);
    // Initialize global objects.
    this.initFunction(globalObject);
    this.initObject(globalObject);
    // Unable to set globalObject's parent prior (OBJECT did not exist).
    // Note that in a browser this would be `Window`, whereas in Node.js it would
    // be `Object`.  This interpreter is closer to Node in that it has no DOM.
    globalObject.proto = this.OBJECT_PROTO;
    this.setProperty(globalObject, 'constructor', this.OBJECT,
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    this.initArray(globalObject);
    this.initString(globalObject);
    this.initBoolean(globalObject);
    this.initNumber(globalObject);
    this.initDate(globalObject);
    this.initRegExp(globalObject);
    this.initError(globalObject);
    this.initMath(globalObject);
    this.initJSON(globalObject);

    // Initialize global functions.
    const thisInterpreter = this;
    const func = this.createNativeFunction(
        function(x) {
            throw EvalError('Can\'t happen');
        }, false);
    func.eval = true;
    this.setProperty(globalObject, 'eval', func);

    this.setProperty(globalObject, 'parseInt',
        this.createNativeFunction(parseInt, false));
    this.setProperty(globalObject, 'parseFloat',
        this.createNativeFunction(parseFloat, false));

    this.setProperty(globalObject, 'isNaN',
        this.createNativeFunction(isNaN, false));

    this.setProperty(globalObject, 'isFinite',
        this.createNativeFunction(isFinite, false));

    const strFunctions = [
        [escape, 'escape'], [unescape, 'unescape'],
        [decodeURI, 'decodeURI'], [decodeURIComponent, 'decodeURIComponent'],
        [encodeURI, 'encodeURI'], [encodeURIComponent, 'encodeURIComponent'],
    ];
    for (let i = 0; i < strFunctions.length; i++) {
        const wrapper = (function(nativeFunc) {
            return function(str) {
                try {
                    return nativeFunc(str);
                } catch (e) {
                    // decodeURI('%xy') will throw an error.  Catch and rethrow.
                    thisInterpreter.throwException(thisInterpreter.URI_ERROR, e.message);
                }
            };
        })(strFunctions[i][0]);
        this.setProperty(globalObject, strFunctions[i][1],
            this.createNativeFunction(wrapper, false),
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    }
    // Preserve publicly properties from being pruned/renamed by JS compilers.
    // Add others as needed.
    this['OBJECT'] = this.OBJECT;
    this['OBJECT_PROTO'] = this.OBJECT_PROTO;
    this['FUNCTION'] = this.FUNCTION;
    this['FUNCTION_PROTO'] = this.FUNCTION_PROTO;
    this['ARRAY'] = this.ARRAY;
    this['ARRAY_PROTO'] = this.ARRAY_PROTO;
    this['REGEXP'] = this.REGEXP;
    this['REGEXP_PROTO'] = this.REGEXP_PROTO;
    this['DATE'] = this.DATE;
    this['DATE_PROTO'] = this.DATE_PROTO;

    // Run any user-provided initialization.
    if (this.initFunc_) {
        this.initFunc_(this, globalObject);
    }
};

/**
 * Initialize the Function class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initFunction = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    const identifierRegexp = /^[A-Za-z_$][\w$]*$/;
    // Function constructor.
    wrapper = function(var_args) {
        if (arguments.length) {
            var code = String(arguments[arguments.length - 1]);
        } else {
            var code = '';
        }
        let argsStr = Array.prototype.slice.call(arguments, 0, -1).join(',').trim();
        if (argsStr) {
            const args = argsStr.split(/\s*,\s*/);
            for (let i = 0; i < args.length; i++) {
                const name = args[i];
                if (!identifierRegexp.test(name)) {
                    thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
                        'Invalid function argument: ' + name);
                }
            }
            argsStr = args.join(', ');
        }
        // Acorn needs to parse code in the context of a function or else `return`
        // statements will be syntax errors.
        try {
            var ast = acorn.parse('(function(' + argsStr + ') {' + code + '})',
                S8Interpreter.PARSE_OPTIONS);
        } catch (e) {
            // Acorn threw a SyntaxError.  Rethrow as a trappable error.
            thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
                'Invalid code: ' + e.message);
        }
        if (ast['body'].length !== 1) {
            // Function('a', 'return a + 6;}; {alert(1);');
            thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR,
                'Invalid code in function body.');
        }
        const node = ast['body'][0]['expression'];
        // Note that if this constructor is called as `new Function()` the function
        // object created by stepCallExpression and assigned to `this` is discarded.
        // Interestingly, the scope for constructed functions is the global scope,
        // even if they were constructed in some other scope.
        return thisInterpreter.createFunction(node, thisInterpreter.globalScope);
    };
    this.FUNCTION = this.createNativeFunction(wrapper, true);

    this.setProperty(globalObject, 'Function', this.FUNCTION);
    // Throw away the created prototype and use the root prototype.
    this.setProperty(this.FUNCTION, 'prototype', this.FUNCTION_PROTO,
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    // Configure Function.prototype.
    this.setProperty(this.FUNCTION_PROTO, 'constructor', this.FUNCTION,
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    this.FUNCTION_PROTO.nativeFunc = function() {
    };
    this.FUNCTION_PROTO.nativeFunc.id = this.functionCounter_++;
    this.setProperty(this.FUNCTION_PROTO, 'length', 0,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);

    const boxThis = function(value) {
        // In non-strict mode `this` must be an object.
        if (!(value instanceof S8Interpreter.Object) &&
            !thisInterpreter.getScope().strict) {
            if (value === undefined || value === null) {
                // `Undefined` and `null` are changed to the global object.
                value = thisInterpreter.globalObject;
            } else {
                // Primitives must be boxed in non-strict mode.
                const box = thisInterpreter.createObjectProto(
                    thisInterpreter.getPrototype(value));
                box.data = value;
                value = box;
            }
        }
        return value;
    };

    wrapper = function(thisArg, args) {
        const state =
            thisInterpreter.stateStack[thisInterpreter.stateStack.length - 1];
        // Rewrite the current CallExpression state to apply a different function.
        state.func_ = this;
        // Assign the `this` object.
        state.funcThis_ = boxThis(thisArg);
        // Bind any provided arguments.
        state.arguments_ = [];
        if (args !== null && args !== undefined) {
            if (args instanceof S8Interpreter.Object) {
                state.arguments_ = thisInterpreter.arrayPseudoToNative(args);
            } else {
                thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                    'CreateListFromArrayLike called on non-object');
            }
        }
        state.doneExec_ = false;
    };
    this.setNativeFunctionPrototype(this.FUNCTION, 'apply', wrapper);

    wrapper = function(thisArg /*, var_args */) {
        const state =
            thisInterpreter.stateStack[thisInterpreter.stateStack.length - 1];
        // Rewrite the current CallExpression state to call a different function.
        state.func_ = this;
        // Assign the `this` object.
        state.funcThis_ = boxThis(thisArg);
        // Bind any provided arguments.
        state.arguments_ = [];
        for (let i = 1; i < arguments.length; i++) {
            state.arguments_.push(arguments[i]);
        }
        state.doneExec_ = false;
    };
    this.setNativeFunctionPrototype(this.FUNCTION, 'call', wrapper);

    this.polyfills_.push(
// Polyfill copied from:
// developer.mozilla.org/en/docs/Web/JavaScript/Reference/Global_objects/Function/bind
        'Object.defineProperty(Function.prototype, \'bind\',',
        '{configurable: true, writable: true, value:',
        'function(oThis) {',
        'if (typeof this !== \'function\') {',
        'throw TypeError(\'What is trying to be bound is not callable\');',
        '}',
        'var aArgs   = Array.prototype.slice.call(arguments, 1),',
        'fToBind = this,',
        'fNOP    = function() {},',
        'fBound  = function() {',
        'return fToBind.apply(this instanceof fNOP',
        '? this',
        ': oThis,',
        'aArgs.concat(Array.prototype.slice.call(arguments)));',
        '};',
        'if (this.prototype) {',
        'fNOP.prototype = this.prototype;',
        '}',
        'fBound.prototype = new fNOP();',
        'return fBound;',
        '}',
        '});',
        '');

    // Function has no parent to inherit from, so it needs its own mandatory
    // toString and valueOf functions.
    wrapper = function() {
        return String(this);
    };
    this.setNativeFunctionPrototype(this.FUNCTION, 'toString', wrapper);
    this.setProperty(this.FUNCTION, 'toString',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    wrapper = function() {
        return this.valueOf();
    };
    this.setNativeFunctionPrototype(this.FUNCTION, 'valueOf', wrapper);
    this.setProperty(this.FUNCTION, 'valueOf',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
};

/**
 * Initialize the Object class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initObject = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    // Object constructor.
    wrapper = function(value) {
        if (value === undefined || value === null) {
            // Create a new object.
            if (thisInterpreter.calledWithNew()) {
                // Called as `new Object()`.
                return this;
            } else {
                // Called as `Object()`.
                return thisInterpreter.createObjectProto(thisInterpreter.OBJECT_PROTO);
            }
        }
        if (!(value instanceof S8Interpreter.Object)) {
            // Wrap the value as an object.
            const box = thisInterpreter.createObjectProto(
                thisInterpreter.getPrototype(value));
            box.data = value;
            return box;
        }
        // Return the provided object.
        return value;
    };
    this.OBJECT = this.createNativeFunction(wrapper, true);
    // Throw away the created prototype and use the root prototype.
    this.setProperty(this.OBJECT, 'prototype', this.OBJECT_PROTO,
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    this.setProperty(this.OBJECT_PROTO, 'constructor', this.OBJECT,
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    this.setProperty(globalObject, 'Object', this.OBJECT);

    /**
     * Checks if the provided value is null or undefined.
     * If so, then throw an error in the call stack.
     * @param {S8Interpreter.Value} value Value to check.
     */
    const throwIfNullUndefined = function(value) {
        if (value === undefined || value === null) {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                'Cannot convert \'' + value + '\' to object');
        }
    };

    // Static methods on Object.
    wrapper = function(obj) {
        throwIfNullUndefined(obj);
        const props = (obj instanceof S8Interpreter.Object) ? obj.properties : obj;
        return thisInterpreter.arrayNativeToPseudo(
            Object.getOwnPropertyNames(props));
    };
    this.setProperty(this.OBJECT, 'getOwnPropertyNames',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    wrapper = function(obj) {
        throwIfNullUndefined(obj);
        if (obj instanceof S8Interpreter.Object) {
            obj = obj.properties;
        }
        return thisInterpreter.arrayNativeToPseudo(Object.keys(obj));
    };
    this.setProperty(this.OBJECT, 'keys',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    wrapper = function(proto) {
        // Support for the second argument is the responsibility of a polyfill.
        if (proto === null) {
            return thisInterpreter.createObjectProto(null);
        }
        if (!(proto instanceof S8Interpreter.Object)) {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                'Object prototype may only be an Object or null');
        }
        return thisInterpreter.createObjectProto(proto);
    };
    this.setProperty(this.OBJECT, 'create',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    // Add a polyfill to handle create's second argument.
    this.polyfills_.push(
        '(function() {',
        'var create_ = Object.create;',
        'Object.create = function(proto, props) {',
        'var obj = create_(proto);',
        'props && Object.defineProperties(obj, props);',
        'return obj;',
        '};',
        '})();',
        '');

    wrapper = function(obj, prop, descriptor) {
        prop = String(prop);
        if (!(obj instanceof S8Interpreter.Object)) {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                'Object.defineProperty called on non-object');
        }
        if (!(descriptor instanceof S8Interpreter.Object)) {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                'Property description must be an object');
        }
        if (!obj.properties[prop] && obj.preventExtensions) {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                'Can\'t define property \'' + prop + '\', object is not extensible');
        }
        // The polyfill guarantees no inheritance and no getter functions.
        // Therefore the descriptor properties map is the native object needed.
        thisInterpreter.setProperty(obj, prop, S8Interpreter.VALUE_IN_DESCRIPTOR,
            descriptor.properties);
        return obj;
    };
    this.setProperty(this.OBJECT, 'defineProperty',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    this.polyfills_.push(
// Flatten the descriptor to remove any inheritance or getter functions.
        '(function() {',
        'var defineProperty_ = Object.defineProperty;',
        'Object.defineProperty = function(obj, prop, d1) {',
        'var d2 = {};',
        'if (\'configurable\' in d1) d2.configurable = d1.configurable;',
        'if (\'enumerable\' in d1) d2.enumerable = d1.enumerable;',
        'if (\'writable\' in d1) d2.writable = d1.writable;',
        'if (\'value\' in d1) d2.value = d1.value;',
        'if (\'get\' in d1) d2.get = d1.get;',
        'if (\'set\' in d1) d2.set = d1.set;',
        'return defineProperty_(obj, prop, d2);',
        '};',
        '})();',

        'Object.defineProperty(Object, \'defineProperties\',',
        '{configurable: true, writable: true, value:',
        'function(obj, props) {',
        'var keys = Object.keys(props);',
        'for (var i = 0; i < keys.length; i++) {',
        'Object.defineProperty(obj, keys[i], props[keys[i]]);',
        '}',
        'return obj;',
        '}',
        '});',
        '');

    wrapper = function(obj, prop) {
        if (!(obj instanceof S8Interpreter.Object)) {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                'Object.getOwnPropertyDescriptor called on non-object');
        }
        prop = String(prop);
        if (!(prop in obj.properties)) {
            return undefined;
        }
        const descriptor = Object.getOwnPropertyDescriptor(obj.properties, prop);
        const getter = obj.getter[prop];
        const setter = obj.setter[prop];

        const pseudoDescriptor =
            thisInterpreter.createObjectProto(thisInterpreter.OBJECT_PROTO);
        if (getter || setter) {
            thisInterpreter.setProperty(pseudoDescriptor, 'get', getter);
            thisInterpreter.setProperty(pseudoDescriptor, 'set', setter);
        } else {
            thisInterpreter.setProperty(pseudoDescriptor, 'value',
                descriptor.value);
            thisInterpreter.setProperty(pseudoDescriptor, 'writable',
                descriptor.writable);
        }
        thisInterpreter.setProperty(pseudoDescriptor, 'configurable',
            descriptor.configurable);
        thisInterpreter.setProperty(pseudoDescriptor, 'enumerable',
            descriptor.enumerable);
        return pseudoDescriptor;
    };
    this.setProperty(this.OBJECT, 'getOwnPropertyDescriptor',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    wrapper = function(obj) {
        throwIfNullUndefined(obj);
        return thisInterpreter.getPrototype(obj);
    };
    this.setProperty(this.OBJECT, 'getPrototypeOf',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    wrapper = function(obj) {
        return Boolean(obj) && !obj.preventExtensions;
    };
    this.setProperty(this.OBJECT, 'isExtensible',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    wrapper = function(obj) {
        if (obj instanceof S8Interpreter.Object) {
            obj.preventExtensions = true;
        }
        return obj;
    };
    this.setProperty(this.OBJECT, 'preventExtensions',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    // Instance methods on Object.
    this.setNativeFunctionPrototype(this.OBJECT, 'toString',
        S8Interpreter.Object.prototype.toString);
    this.setNativeFunctionPrototype(this.OBJECT, 'toLocaleString',
        S8Interpreter.Object.prototype.toString);
    this.setNativeFunctionPrototype(this.OBJECT, 'valueOf',
        S8Interpreter.Object.prototype.valueOf);

    wrapper = function(prop) {
        throwIfNullUndefined(this);
        if (this instanceof S8Interpreter.Object) {
            return String(prop) in this.properties;
        }
        // Primitive.
        return this.hasOwnProperty(prop);
    };
    this.setNativeFunctionPrototype(this.OBJECT, 'hasOwnProperty', wrapper);

    wrapper = function(prop) {
        throwIfNullUndefined(this);
        if (this instanceof S8Interpreter.Object) {
            return Object.prototype.propertyIsEnumerable.call(this.properties, prop);
        }
        // Primitive.
        return this.propertyIsEnumerable(prop);
    };
    this.setNativeFunctionPrototype(this.OBJECT, 'propertyIsEnumerable', wrapper);

    wrapper = function(obj) {
        while (true) {
            // Note, circular loops shouldn't be possible.
            obj = thisInterpreter.getPrototype(obj);
            if (!obj) {
                // No parent; reached the top.
                return false;
            }
            if (obj === this) {
                return true;
            }
        }
    };
    this.setNativeFunctionPrototype(this.OBJECT, 'isPrototypeOf', wrapper);
};

/**
 * Initialize the Array class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initArray = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    // Array constructor.
    wrapper = function(var_args) {
        if (thisInterpreter.calledWithNew()) {
            // Called as `new Array()`.
            var newArray = this;
        } else {
            // Called as `Array()`.
            var newArray = thisInterpreter.createArray();
        }
        const first = arguments[0];
        if (arguments.length === 1 && typeof first === 'number') {
            if (isNaN(S8Interpreter.legalArrayLength(first))) {
                thisInterpreter.throwException(thisInterpreter.RANGE_ERROR,
                    'Invalid array length');
            }
            newArray.properties.length = first;
        } else {
            for (var i = 0; i < arguments.length; i++) {
                newArray.properties[i] = arguments[i];
            }
            newArray.properties.length = i;
        }
        return newArray;
    };
    this.ARRAY = this.createNativeFunction(wrapper, true);
    this.ARRAY_PROTO = this.ARRAY.properties['prototype'];
    this.setProperty(globalObject, 'Array', this.ARRAY);

    // Static methods on Array.
    wrapper = function(obj) {
        return obj && obj.class === 'Array';
    };
    this.setProperty(this.ARRAY, 'isArray',
        this.createNativeFunction(wrapper, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    // Instance methods on Array.
    this.setProperty(this.ARRAY_PROTO, 'length', 0,
        { configurable: false, enumerable: false, writable: true });
    this.ARRAY_PROTO.class = 'Array';

    wrapper = function() {
        return Array.prototype.pop.call(this.properties);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'pop', wrapper);

    wrapper = function(var_args) {
        return Array.prototype.push.apply(this.properties, arguments);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'push', wrapper);

    wrapper = function() {
        return Array.prototype.shift.call(this.properties);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'shift', wrapper);

    wrapper = function(var_args) {
        return Array.prototype.unshift.apply(this.properties, arguments);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'unshift', wrapper);

    wrapper = function() {
        Array.prototype.reverse.call(this.properties);
        return this;
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'reverse', wrapper);

    wrapper = function(index, howmany /*, var_args*/) {
        const list = Array.prototype.splice.apply(this.properties, arguments);
        return thisInterpreter.arrayNativeToPseudo(list);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'splice', wrapper);

    wrapper = function(opt_begin, opt_end) {
        const list = Array.prototype.slice.call(this.properties, opt_begin, opt_end);
        return thisInterpreter.arrayNativeToPseudo(list);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'slice', wrapper);

    wrapper = function(opt_separator) {
        return Array.prototype.join.call(this.properties, opt_separator);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'join', wrapper);

    wrapper = function(var_args) {
        const list = [];
        let length = 0;
        // Start by copying the current array.
        const iLength = thisInterpreter.getProperty(this, 'length');
        for (var i = 0; i < iLength; i++) {
            if (thisInterpreter.hasProperty(this, i)) {
                const element = thisInterpreter.getProperty(this, i);
                list[length] = element;
            }
            length++;
        }
        // Loop through all arguments and copy them in.
        for (var i = 0; i < arguments.length; i++) {
            const value = arguments[i];
            if (thisInterpreter.isa(value, thisInterpreter.ARRAY)) {
                const jLength = thisInterpreter.getProperty(value, 'length');
                for (let j = 0; j < jLength; j++) {
                    if (thisInterpreter.hasProperty(value, j)) {
                        list[length] = thisInterpreter.getProperty(value, j);
                    }
                    length++;
                }
            } else {
                list[length] = value;
            }
        }
        return thisInterpreter.arrayNativeToPseudo(list);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'concat', wrapper);

    wrapper = function(searchElement, opt_fromIndex) {
        return Array.prototype.indexOf.apply(this.properties, arguments);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'indexOf', wrapper);

    wrapper = function(searchElement, opt_fromIndex) {
        return Array.prototype.lastIndexOf.apply(this.properties, arguments);
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'lastIndexOf', wrapper);

    wrapper = function() {
        Array.prototype.sort.call(this.properties);
        return this;
    };
    this.setNativeFunctionPrototype(this.ARRAY, 'sort', wrapper);

    this.polyfills_.push(
// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/every
        'Object.defineProperty(Array.prototype, \'every\',',
        '{configurable: true, writable: true, value:',
        'function(callbackfn, thisArg) {',
        'if (!this || typeof callbackfn !== \'function\') throw TypeError();',
        'var T, k;',
        'var O = Object(this);',
        'var len = O.length >>> 0;',
        'if (arguments.length > 1) T = thisArg;',
        'k = 0;',
        'while (k < len) {',
        'if (k in O && !callbackfn.call(T, O[k], k, O)) return false;',
        'k++;',
        '}',
        'return true;',
        '}',
        '});',

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/filter
        'Object.defineProperty(Array.prototype, \'filter\',',
        '{configurable: true, writable: true, value:',
        'function(fun/*, thisArg*/) {',
        'if (this === void 0 || this === null || typeof fun !== \'function\') throw TypeError();',
        'var t = Object(this);',
        'var len = t.length >>> 0;',
        'var res = [];',
        'var thisArg = arguments.length >= 2 ? arguments[1] : void 0;',
        'for (var i = 0; i < len; i++) {',
        'if (i in t) {',
        'var val = t[i];',
        'if (fun.call(thisArg, val, i, t)) res.push(val);',
        '}',
        '}',
        'return res;',
        '}',
        '});',

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach
        'Object.defineProperty(Array.prototype, \'forEach\',',
        '{configurable: true, writable: true, value:',
        'function(callback, thisArg) {',
        'if (!this || typeof callback !== \'function\') throw TypeError();',
        'var T, k;',
        'var O = Object(this);',
        'var len = O.length >>> 0;',
        'if (arguments.length > 1) T = thisArg;',
        'k = 0;',
        'while (k < len) {',
        'if (k in O) callback.call(T, O[k], k, O);',
        'k++;',
        '}',
        '}',
        '});',

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/map
        'Object.defineProperty(Array.prototype, \'map\',',
        '{configurable: true, writable: true, value:',
        'function(callback, thisArg) {',
        'if (!this || typeof callback !== \'function\') new TypeError;',
        'var T, A, k;',
        'var O = Object(this);',
        'var len = O.length >>> 0;',
        'if (arguments.length > 1) T = thisArg;',
        'A = new Array(len);',
        'k = 0;',
        'while (k < len) {',
        'if (k in O) A[k] = callback.call(T, O[k], k, O);',
        'k++;',
        '}',
        'return A;',
        '}',
        '});',

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/Reduce
        'Object.defineProperty(Array.prototype, \'reduce\',',
        '{configurable: true, writable: true, value:',
        'function(callback /*, initialValue*/) {',
        'if (!this || typeof callback !== \'function\') throw TypeError();',
        'var t = Object(this), len = t.length >>> 0, k = 0, value;',
        'if (arguments.length === 2) {',
        'value = arguments[1];',
        '} else {',
        'while (k < len && !(k in t)) k++;',
        'if (k >= len) {',
        'throw TypeError(\'Reduce of empty array with no initial value\');',
        '}',
        'value = t[k++];',
        '}',
        'for (; k < len; k++) {',
        'if (k in t) value = callback(value, t[k], k, t);',
        '}',
        'return value;',
        '}',
        '});',

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/ReduceRight
        'Object.defineProperty(Array.prototype, \'reduceRight\',',
        '{configurable: true, writable: true, value:',
        'function(callback /*, initialValue*/) {',
        'if (null === this || \'undefined\' === typeof this || \'function\' !== typeof callback) throw TypeError();',
        'var t = Object(this), len = t.length >>> 0, k = len - 1, value;',
        'if (arguments.length >= 2) {',
        'value = arguments[1];',
        '} else {',
        'while (k >= 0 && !(k in t)) k--;',
        'if (k < 0) {',
        'throw TypeError(\'Reduce of empty array with no initial value\');',
        '}',
        'value = t[k--];',
        '}',
        'for (; k >= 0; k--) {',
        'if (k in t) value = callback(value, t[k], k, t);',
        '}',
        'return value;',
        '}',
        '});',

// Polyfill copied from:
// developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array/some
        'Object.defineProperty(Array.prototype, \'some\',',
        '{configurable: true, writable: true, value:',
        'function(fun/*, thisArg*/) {',
        'if (!this || typeof fun !== \'function\') throw TypeError();',
        'var t = Object(this);',
        'var len = t.length >>> 0;',
        'var thisArg = arguments.length >= 2 ? arguments[1] : void 0;',
        'for (var i = 0; i < len; i++) {',
        'if (i in t && fun.call(thisArg, t[i], i, t)) {',
        'return true;',
        '}',
        '}',
        'return false;',
        '}',
        '});',


        '(function() {',
        'var sort_ = Array.prototype.sort;',
        'Array.prototype.sort = function(opt_comp) {',
        // Fast native sort.
        'if (typeof opt_comp !== \'function\') {',
        'return sort_.call(this);',
        '}',
        // Slow bubble sort.
        'for (var i = 0; i < this.length; i++) {',
        'var changes = 0;',
        'for (var j = 0; j < this.length - i - 1; j++) {',
        'if (opt_comp(this[j], this[j + 1]) > 0) {',
        'var swap = this[j];',
        'this[j] = this[j + 1];',
        'this[j + 1] = swap;',
        'changes++;',
        '}',
        '}',
        'if (!changes) break;',
        '}',
        'return this;',
        '};',
        '})();',

        'Object.defineProperty(Array.prototype, \'toLocaleString\',',
        '{configurable: true, writable: true, value:',
        'function() {',
        'var out = [];',
        'for (var i = 0; i < this.length; i++) {',
        'out[i] = (this[i] === null || this[i] === undefined) ? \'\' : this[i].toLocaleString();',
        '}',
        'return out.join(\',\');',
        '}',
        '});',
        '');
};

/**
 * Initialize the String class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initString = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    // String constructor.
    wrapper = function(value) {
        value = arguments.length ? String(value) : '';
        if (thisInterpreter.calledWithNew()) {
            // Called as `new String()`.
            this.data = value;
            return this;
        } else {
            // Called as `String()`.
            return value;
        }
    };
    this.STRING = this.createNativeFunction(wrapper, true);
    this.setProperty(globalObject, 'String', this.STRING);

    // Static methods on String.
    this.setProperty(this.STRING, 'fromCharCode',
        this.createNativeFunction(String.fromCharCode, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    // Instance methods on String.
    // Methods with exclusively primitive arguments.
    const functions = ['charAt', 'charCodeAt', 'concat', 'indexOf', 'lastIndexOf',
        'slice', 'substr', 'substring', 'toLocaleLowerCase', 'toLocaleUpperCase',
        'toLowerCase', 'toUpperCase', 'trim'];
    for (let i = 0; i < functions.length; i++) {
        this.setNativeFunctionPrototype(this.STRING, functions[i],
            String.prototype[functions[i]]);
    }

    wrapper = function(compareString, locales, options) {
        locales = locales ? thisInterpreter.pseudoToNative(locales) : undefined;
        options = options ? thisInterpreter.pseudoToNative(options) : undefined;
        return String(this).localeCompare(compareString, locales, options);
    };
    this.setNativeFunctionPrototype(this.STRING, 'localeCompare', wrapper);

    wrapper = function(separator, limit, callback) {
        const string = String(this);
        limit = limit ? Number(limit) : undefined;
        // Example of catastrophic split RegExp:
        // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.split(/^(a+)+b/)
        if (thisInterpreter.isa(separator, thisInterpreter.REGEXP)) {
            separator = separator.data;
            thisInterpreter.maybeThrowRegExp(separator, callback);
            if (thisInterpreter['REGEXP_MODE'] === 2) {
                if (S8Interpreter.vm) {
                    // Run split in vm.
                    const sandbox = {
                        'string': string,
                        'separator': separator,
                        'limit': limit,
                    };
                    const code = 'string.split(separator, limit)';
                    var jsList =
                        thisInterpreter.vmCall(code, sandbox, separator, callback);
                    if (jsList !== S8Interpreter.REGEXP_TIMEOUT) {
                        callback(thisInterpreter.arrayNativeToPseudo(jsList));
                    }
                } else {
                    // Run split in separate thread.
                    const splitWorker = thisInterpreter.createWorker();
                    const pid = thisInterpreter.regExpTimeout(separator, splitWorker,
                        callback);
                    splitWorker.onmessage = function(e) {
                        clearTimeout(pid);
                        callback(thisInterpreter.arrayNativeToPseudo(e.data));
                    };
                    splitWorker.postMessage(['split', string, separator, limit]);
                }
                return;
            }
        }
        // Run split natively.
        var jsList = string.split(separator, limit);
        callback(thisInterpreter.arrayNativeToPseudo(jsList));
    };
    this.setAsyncFunctionPrototype(this.STRING, 'split', wrapper);

    wrapper = function(regexp, callback) {
        const string = String(this);
        if (thisInterpreter.isa(regexp, thisInterpreter.REGEXP)) {
            regexp = regexp.data;
        } else {
            regexp = new RegExp(regexp);
        }
        // Example of catastrophic match RegExp:
        // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.match(/^(a+)+b/)
        thisInterpreter.maybeThrowRegExp(regexp, callback);
        if (thisInterpreter['REGEXP_MODE'] === 2) {
            if (S8Interpreter.vm) {
                // Run match in vm.
                const sandbox = {
                    'string': string,
                    'regexp': regexp,
                };
                const code = 'string.match(regexp)';
                var m = thisInterpreter.vmCall(code, sandbox, regexp, callback);
                if (m !== S8Interpreter.REGEXP_TIMEOUT) {
                    callback(m && thisInterpreter.arrayNativeToPseudo(m));
                }
            } else {
                // Run match in separate thread.
                const matchWorker = thisInterpreter.createWorker();
                const pid = thisInterpreter.regExpTimeout(regexp, matchWorker, callback);
                matchWorker.onmessage = function(e) {
                    clearTimeout(pid);
                    callback(e.data && thisInterpreter.arrayNativeToPseudo(e.data));
                };
                matchWorker.postMessage(['match', string, regexp]);
            }
            return;
        }
        // Run match natively.
        var m = string.match(regexp);
        callback(m && thisInterpreter.arrayNativeToPseudo(m));
    };
    this.setAsyncFunctionPrototype(this.STRING, 'match', wrapper);

    wrapper = function(regexp, callback) {
        const string = String(this);
        if (thisInterpreter.isa(regexp, thisInterpreter.REGEXP)) {
            regexp = regexp.data;
        } else {
            regexp = new RegExp(regexp);
        }
        // Example of catastrophic search RegExp:
        // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.search(/^(a+)+b/)
        thisInterpreter.maybeThrowRegExp(regexp, callback);
        if (thisInterpreter['REGEXP_MODE'] === 2) {
            if (S8Interpreter.vm) {
                // Run search in vm.
                const sandbox = {
                    'string': string,
                    'regexp': regexp,
                };
                const code = 'string.search(regexp)';
                const n = thisInterpreter.vmCall(code, sandbox, regexp, callback);
                if (n !== S8Interpreter.REGEXP_TIMEOUT) {
                    callback(n);
                }
            } else {
                // Run search in separate thread.
                const searchWorker = thisInterpreter.createWorker();
                const pid = thisInterpreter.regExpTimeout(regexp, searchWorker, callback);
                searchWorker.onmessage = function(e) {
                    clearTimeout(pid);
                    callback(e.data);
                };
                searchWorker.postMessage(['search', string, regexp]);
            }
            return;
        }
        // Run search natively.
        callback(string.search(regexp));
    };
    this.setAsyncFunctionPrototype(this.STRING, 'search', wrapper);

    wrapper = function(substr, newSubstr, callback) {
        // Support for function replacements is the responsibility of a polyfill.
        const string = String(this);
        newSubstr = String(newSubstr);
        // Example of catastrophic replace RegExp:
        // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac'.replace(/^(a+)+b/, '')
        if (thisInterpreter.isa(substr, thisInterpreter.REGEXP)) {
            substr = substr.data;
            thisInterpreter.maybeThrowRegExp(substr, callback);
            if (thisInterpreter['REGEXP_MODE'] === 2) {
                if (S8Interpreter.vm) {
                    // Run replace in vm.
                    const sandbox = {
                        'string': string,
                        'substr': substr,
                        'newSubstr': newSubstr,
                    };
                    const code = 'string.replace(substr, newSubstr)';
                    const str = thisInterpreter.vmCall(code, sandbox, substr, callback);
                    if (str !== S8Interpreter.REGEXP_TIMEOUT) {
                        callback(str);
                    }
                } else {
                    // Run replace in separate thread.
                    const replaceWorker = thisInterpreter.createWorker();
                    const pid = thisInterpreter.regExpTimeout(substr, replaceWorker,
                        callback);
                    replaceWorker.onmessage = function(e) {
                        clearTimeout(pid);
                        callback(e.data);
                    };
                    replaceWorker.postMessage(['replace', string, substr, newSubstr]);
                }
                return;
            }
        }
        // Run replace natively.
        callback(string.replace(substr, newSubstr));
    };
    this.setAsyncFunctionPrototype(this.STRING, 'replace', wrapper);
    // Add a polyfill to handle replace's second argument being a function.
    this.polyfills_.push(
        '(function() {',
        'var replace_ = String.prototype.replace;',
        'String.prototype.replace = function(substr, newSubstr) {',
        'if (typeof newSubstr !== \'function\') {',
        // string.replace(string|regexp, string)
        'return replace_.call(this, substr, newSubstr);',
        '}',
        'var str = this;',
        'if (substr instanceof RegExp) {',  // string.replace(regexp, function)
        'var subs = [];',
        'var m = substr.exec(str);',
        'while (m) {',
        'm.push(m.index, str);',
        'var inject = newSubstr.apply(null, m);',
        'subs.push([m.index, m[0].length, inject]);',
        'm = substr.global ? substr.exec(str) : null;',
        '}',
        'for (var i = subs.length - 1; i >= 0; i--) {',
        'str = str.substring(0, subs[i][0]) + subs[i][2] + ' +
        'str.substring(subs[i][0] + subs[i][1]);',
        '}',
        '} else {',                         // string.replace(string, function)
        'var i = str.indexOf(substr);',
        'if (i !== -1) {',
        'var inject = newSubstr(str.substr(i, substr.length), i, str);',
        'str = str.substring(0, i) + inject + ' +
        'str.substring(i + substr.length);',
        '}',
        '}',
        'return str;',
        '};',
        '})();',
        '');
};

/**
 * Initialize the Boolean class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initBoolean = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    // Boolean constructor.
    wrapper = function(value) {
        value = Boolean(value);
        if (thisInterpreter.calledWithNew()) {
            // Called as `new Boolean()`.
            this.data = value;
            return this;
        } else {
            // Called as `Boolean()`.
            return value;
        }
    };
    this.BOOLEAN = this.createNativeFunction(wrapper, true);
    this.setProperty(globalObject, 'Boolean', this.BOOLEAN);
};

/**
 * Initialize the Number class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initNumber = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    // Number constructor.
    wrapper = function(value) {
        value = arguments.length ? Number(value) : 0;
        if (thisInterpreter.calledWithNew()) {
            // Called as `new Number()`.
            this.data = value;
            return this;
        } else {
            // Called as `Number()`.
            return value;
        }
    };
    this.NUMBER = this.createNativeFunction(wrapper, true);
    this.setProperty(globalObject, 'Number', this.NUMBER);

    const numConsts = ['MAX_VALUE', 'MIN_VALUE', 'NaN', 'NEGATIVE_INFINITY',
        'POSITIVE_INFINITY'];
    for (let i = 0; i < numConsts.length; i++) {
        this.setProperty(this.NUMBER, numConsts[i], Number[numConsts[i]],
            S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    }

    // Instance methods on Number.
    wrapper = function(fractionDigits) {
        try {
            return Number(this).toExponential(fractionDigits);
        } catch (e) {
            // Throws if fractionDigits isn't within 0-20.
            thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
        }
    };
    this.setNativeFunctionPrototype(this.NUMBER, 'toExponential', wrapper);

    wrapper = function(digits) {
        try {
            return Number(this).toFixed(digits);
        } catch (e) {
            // Throws if digits isn't within 0-20.
            thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
        }
    };
    this.setNativeFunctionPrototype(this.NUMBER, 'toFixed', wrapper);

    wrapper = function(precision) {
        try {
            return Number(this).toPrecision(precision);
        } catch (e) {
            // Throws if precision isn't within range (depends on implementation).
            thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
        }
    };
    this.setNativeFunctionPrototype(this.NUMBER, 'toPrecision', wrapper);

    wrapper = function(radix) {
        try {
            return Number(this).toString(radix);
        } catch (e) {
            // Throws if radix isn't within 2-36.
            thisInterpreter.throwException(thisInterpreter.ERROR, e.message);
        }
    };
    this.setNativeFunctionPrototype(this.NUMBER, 'toString', wrapper);

    wrapper = function(locales, options) {
        locales = locales ? thisInterpreter.pseudoToNative(locales) : undefined;
        options = options ? thisInterpreter.pseudoToNative(options) : undefined;
        return Number(this).toLocaleString(locales, options);
    };
    this.setNativeFunctionPrototype(this.NUMBER, 'toLocaleString', wrapper);
};

/**
 * Initialize the Date class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initDate = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    // Date constructor.
    wrapper = function(value, var_args) {
        if (!thisInterpreter.calledWithNew()) {
            // Called as `Date()`.
            // Calling Date() as a function returns a string, no arguments are heeded.
            return Date();
        }
        // Called as `new Date()`.
        const args = [null].concat(Array.from(arguments));
        this.data = new (Function.prototype.bind.apply(Date, args));
        return this;
    };
    this.DATE = this.createNativeFunction(wrapper, true);
    this.DATE_PROTO = this.DATE.properties['prototype'];
    this.setProperty(globalObject, 'Date', this.DATE);

    // Static methods on Date.
    this.setProperty(this.DATE, 'now', this.createNativeFunction(Date.now, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    this.setProperty(this.DATE, 'parse',
        this.createNativeFunction(Date.parse, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    this.setProperty(this.DATE, 'UTC', this.createNativeFunction(Date.UTC, false),
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    // Instance methods on Date.
    const functions = ['getDate', 'getDay', 'getFullYear', 'getHours',
        'getMilliseconds', 'getMinutes', 'getMonth', 'getSeconds', 'getTime',
        'getTimezoneOffset', 'getUTCDate', 'getUTCDay', 'getUTCFullYear',
        'getUTCHours', 'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth',
        'getUTCSeconds', 'getYear',
        'setDate', 'setFullYear', 'setHours', 'setMilliseconds',
        'setMinutes', 'setMonth', 'setSeconds', 'setTime', 'setUTCDate',
        'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes',
        'setUTCMonth', 'setUTCSeconds', 'setYear',
        'toDateString', 'toISOString', 'toJSON', 'toGMTString',
        'toLocaleDateString', 'toLocaleString', 'toLocaleTimeString',
        'toTimeString', 'toUTCString'];
    for (let i = 0; i < functions.length; i++) {
        wrapper = (function(nativeFunc) {
            return function(var_args) {
                const args = [];
                for (let i = 0; i < arguments.length; i++) {
                    args[i] = thisInterpreter.pseudoToNative(arguments[i]);
                }
                return this.data[nativeFunc].apply(this.data, args);
            };
        })(functions[i]);
        this.setNativeFunctionPrototype(this.DATE, functions[i], wrapper);
    }
};

/**
 * Initialize Regular Expression object.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initRegExp = function(globalObject) {
    const thisInterpreter = this;
    let wrapper;
    // RegExp constructor.
    wrapper = function(pattern, flags) {
        if (thisInterpreter.calledWithNew()) {
            // Called as `new RegExp()`.
            var rgx = this;
        } else {
            // Called as `RegExp()`.
            var rgx = thisInterpreter.createObjectProto(thisInterpreter.REGEXP_PROTO);
        }
        pattern = pattern ? String(pattern) : '';
        flags = flags ? String(flags) : '';
        thisInterpreter.populateRegExp(rgx, new RegExp(pattern, flags));
        return rgx;
    };
    this.REGEXP = this.createNativeFunction(wrapper, true);
    this.REGEXP_PROTO = this.REGEXP.properties['prototype'];
    this.setProperty(globalObject, 'RegExp', this.REGEXP);

    this.setProperty(this.REGEXP.properties['prototype'], 'global', undefined,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    this.setProperty(this.REGEXP.properties['prototype'], 'ignoreCase', undefined,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    this.setProperty(this.REGEXP.properties['prototype'], 'multiline', undefined,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    this.setProperty(this.REGEXP.properties['prototype'], 'source', '(?:)',
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);

    // Use polyfill to avoid complexity of regexp threads.
    this.polyfills_.push(
        'Object.defineProperty(RegExp.prototype, \'test\',',
        '{configurable: true, writable: true, value:',
        'function(str) {',
        'return String(str).search(this) !== -1',
        '}',
        '});');

    wrapper = function(string, callback) {
        const regexp = this.data;
        string = String(string);
        // Get lastIndex from wrapped regexp, since this is settable.
        regexp.lastIndex = Number(thisInterpreter.getProperty(this, 'lastIndex'));
        // Example of catastrophic exec RegExp:
        // /^(a+)+b/.exec('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaac')
        thisInterpreter.maybeThrowRegExp(regexp, callback);
        if (thisInterpreter['REGEXP_MODE'] === 2) {
            if (S8Interpreter.vm) {
                // Run exec in vm.
                const sandbox = {
                    'string': string,
                    'regexp': regexp,
                };
                const code = 'regexp.exec(string)';
                var match = thisInterpreter.vmCall(code, sandbox, regexp, callback);
                if (match !== S8Interpreter.REGEXP_TIMEOUT) {
                    thisInterpreter.setProperty(this, 'lastIndex', regexp.lastIndex);
                    callback(matchToPseudo(match));
                }
            } else {
                // Run exec in separate thread.
                // Note that lastIndex is not preserved when a RegExp is passed to a
                // Web Worker.  Thus it needs to be passed back and forth separately.
                const execWorker = thisInterpreter.createWorker();
                const pid = thisInterpreter.regExpTimeout(regexp, execWorker, callback);
                const thisPseudoRegExp = this;
                execWorker.onmessage = function(e) {
                    clearTimeout(pid);
                    // Return tuple: [result, lastIndex]
                    thisInterpreter.setProperty(thisPseudoRegExp, 'lastIndex', e.data[1]);
                    callback(matchToPseudo(e.data[0]));
                };
                execWorker.postMessage(['exec', regexp, regexp.lastIndex, string]);
            }
            return;
        }
        // Run exec natively.
        var match = regexp.exec(string);
        thisInterpreter.setProperty(this, 'lastIndex', regexp.lastIndex);
        callback(matchToPseudo(match));

        function matchToPseudo(match) {
            if (match) {
                const result = thisInterpreter.arrayNativeToPseudo(match);
                // match has additional properties.
                thisInterpreter.setProperty(result, 'index', match.index);
                thisInterpreter.setProperty(result, 'input', match.input);
                return result;
            }
            return null;
        }
    };
    this.setAsyncFunctionPrototype(this.REGEXP, 'exec', wrapper);
};

/**
 * Initialize the Error class.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initError = function(globalObject) {
    const thisInterpreter = this;
    // Error constructor.
    this.ERROR = this.createNativeFunction(function(opt_message) {
        if (thisInterpreter.calledWithNew()) {
            // Called as `new Error()`.
            var newError = this;
        } else {
            // Called as `Error()`.
            var newError = thisInterpreter.createObject(thisInterpreter.ERROR);
        }
        if (opt_message) {
            thisInterpreter.setProperty(newError, 'message', String(opt_message),
                S8Interpreter.NONENUMERABLE_DESCRIPTOR);
        }
        return newError;
    }, true);
    this.setProperty(globalObject, 'Error', this.ERROR);
    this.setProperty(this.ERROR.properties['prototype'], 'message', '',
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    this.setProperty(this.ERROR.properties['prototype'], 'name', 'Error',
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);

    const createErrorSubclass = function(name) {
        const constructor = thisInterpreter.createNativeFunction(
            function(opt_message) {
                if (thisInterpreter.calledWithNew()) {
                    // Called as `new XyzError()`.
                    var newError = this;
                } else {
                    // Called as `XyzError()`.
                    var newError = thisInterpreter.createObject(constructor);
                }
                if (opt_message) {
                    thisInterpreter.setProperty(newError, 'message',
                        String(opt_message), S8Interpreter.NONENUMERABLE_DESCRIPTOR);
                }
                return newError;
            }, true);
        thisInterpreter.setProperty(constructor, 'prototype',
            thisInterpreter.createObject(thisInterpreter.ERROR),
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
        thisInterpreter.setProperty(constructor.properties['prototype'], 'name',
            name, S8Interpreter.NONENUMERABLE_DESCRIPTOR);
        thisInterpreter.setProperty(globalObject, name, constructor);

        return constructor;
    };

    this.EVAL_ERROR = createErrorSubclass('EvalError');
    this.RANGE_ERROR = createErrorSubclass('RangeError');
    this.REFERENCE_ERROR = createErrorSubclass('ReferenceError');
    this.SYNTAX_ERROR = createErrorSubclass('SyntaxError');
    this.TYPE_ERROR = createErrorSubclass('TypeError');
    this.URI_ERROR = createErrorSubclass('URIError');
};

/**
 * Initialize Math object.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initMath = function(globalObject) {
    const myMath = this.createObjectProto(this.OBJECT_PROTO);
    this.setProperty(globalObject, 'Math', myMath);
    const mathConsts = ['E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI',
        'SQRT1_2', 'SQRT2'];
    for (var i = 0; i < mathConsts.length; i++) {
        this.setProperty(myMath, mathConsts[i], Math[mathConsts[i]],
            S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    }
    const numFunctions = ['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos',
        'exp', 'floor', 'log', 'max', 'min', 'pow', 'random',
        'round', 'sin', 'sqrt', 'tan'];
    for (var i = 0; i < numFunctions.length; i++) {
        this.setProperty(myMath, numFunctions[i],
            this.createNativeFunction(Math[numFunctions[i]], false),
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    }
};

/**
 * Initialize JSON object.
 * @param {!S8Interpreter.Object} globalObject Global object.
 */
S8Interpreter.prototype.initJSON = function(globalObject) {
    const thisInterpreter = this;
    const myJSON = thisInterpreter.createObjectProto(this.OBJECT_PROTO);
    this.setProperty(globalObject, 'JSON', myJSON);

    let wrapper = function(text) {
        try {
            var nativeObj = JSON.parse(String(text));
        } catch (e) {
            thisInterpreter.throwException(thisInterpreter.SYNTAX_ERROR, e.message);
        }
        return thisInterpreter.nativeToPseudo(nativeObj);
    };
    this.setProperty(myJSON, 'parse', this.createNativeFunction(wrapper, false));

    wrapper = function(value, replacer, space) {
        if (replacer && replacer.class === 'Function') {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR,
                'Function replacer on JSON.stringify not supported');
        } else if (replacer && replacer.class === 'Array') {
            replacer = thisInterpreter.arrayPseudoToNative(replacer);
            replacer = replacer.filter(function(word) {
                // Spec says we should also support boxed primitives here.
                return typeof word === 'string' || typeof word === 'number';
            });
        } else {
            replacer = null;
        }
        // Spec says we should also support boxed primitives here.
        if (typeof space !== 'string' && typeof space !== 'number') {
            space = undefined;
        }

        const nativeObj = thisInterpreter.pseudoToNative(value);
        try {
            var str = JSON.stringify(nativeObj, replacer, space);
        } catch (e) {
            thisInterpreter.throwException(thisInterpreter.TYPE_ERROR, e.message);
        }
        return str;
    };
    this.setProperty(myJSON, 'stringify',
        this.createNativeFunction(wrapper, false));
};

/**
 * Is an object of a certain class?
 * @param {S8Interpreter.Value} child Object to check.
 * @param {S8Interpreter.Object} constructor Constructor of object.
 * @return {boolean} True if object is the class or inherits from it.
 *     False otherwise.
 */
S8Interpreter.prototype.isa = function(child, constructor) {
    if (child === null || child === undefined || !constructor) {
        return false;
    }
    const proto = constructor.properties['prototype'];
    if (child === proto) {
        return true;
    }
    // The first step up the prototype chain is harder since the child might be
    // a primitive value.  Subsequent steps can just follow the .proto property.
    child = this.getPrototype(child);
    while (child) {
        if (child === proto) {
            return true;
        }
        child = child.proto;
    }
    return false;
};

/**
 * Initialize a pseudo regular expression object based on a native regular
 * expression object.
 * @param {!S8Interpreter.Object} pseudoRegexp The existing object to set.
 * @param {!RegExp} nativeRegexp The native regular expression.
 */
S8Interpreter.prototype.populateRegExp = function(pseudoRegexp, nativeRegexp) {
    pseudoRegexp.data = new RegExp(nativeRegexp.source, nativeRegexp.flags);
    // lastIndex is settable, all others are read-only attributes
    this.setProperty(pseudoRegexp, 'lastIndex', nativeRegexp.lastIndex,
        S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    this.setProperty(pseudoRegexp, 'source', nativeRegexp.source,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    this.setProperty(pseudoRegexp, 'global', nativeRegexp.global,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    this.setProperty(pseudoRegexp, 'ignoreCase', nativeRegexp.ignoreCase,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    this.setProperty(pseudoRegexp, 'multiline', nativeRegexp.multiline,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
};

/**
 * Create a Web Worker to execute regular expressions.
 * Using a separate file fails in Chrome when run locally on a file:// URI.
 * Using a data encoded URI fails in IE and Edge.
 * Using a blob works in IE11 and all other browsers.
 * @return {!Worker} Web Worker with regexp execution code loaded.
 */
S8Interpreter.prototype.createWorker = function() {
    let blob = this.createWorker.blob_;
    if (!blob) {
        blob = new Blob([S8Interpreter.WORKER_CODE.join('\n')],
            { type: 'application/javascript' });
        // Cache the blob, so it doesn't need to be created next time.
        this.createWorker.blob_ = blob;
    }
    return new Worker(URL.createObjectURL(blob));
};

/**
 * Execute regular expressions in a node vm.
 * @param {string} code Code to execute.
 * @param {!Object} sandbox Global variables for new vm.
 * @param {!RegExp} nativeRegExp Regular expression.
 * @param {!Function} callback Asynchronous callback function.
 */
S8Interpreter.prototype.vmCall = function(code, sandbox, nativeRegExp, callback) {
    const options = { 'timeout': this['REGEXP_THREAD_TIMEOUT'] };
    try {
        return S8Interpreter.vm['runInNewContext'](code, sandbox, options);
    } catch (e) {
        callback(null);
        this.throwException(this.ERROR, 'RegExp Timeout: ' + nativeRegExp);
    }
    return S8Interpreter.REGEXP_TIMEOUT;
};

/**
 * If REGEXP_MODE is 0, then throw an error.
 * Also throw if REGEXP_MODE is 2 and JS doesn't support Web Workers or vm.
 * @param {!RegExp} nativeRegExp Regular expression.
 * @param {!Function} callback Asynchronous callback function.
 */
S8Interpreter.prototype.maybeThrowRegExp = function(nativeRegExp, callback) {
    let ok;
    if (this['REGEXP_MODE'] === 0) {
        // Fail: No RegExp support.
        ok = false;
    } else if (this['REGEXP_MODE'] === 1) {
        // Ok: Native RegExp support.
        ok = true;
    } else {
        // Sandboxed RegExp handling.
        if (S8Interpreter.vm) {
            // Ok: Node's vm module already loaded.
            ok = true;
        } else if (typeof Worker === 'function' && typeof URL === 'function') {
            // Ok: Web Workers available.
            ok = true;
        } else if (typeof require === 'function') {
            // Try to load Node's vm module.
            try {
                S8Interpreter.vm = require('vm');
            } catch (e) {
            }
            ok = !!S8Interpreter.vm;
        } else {
            // Fail: Neither Web Workers nor vm available.
            ok = false;
        }
    }
    if (!ok) {
        callback(null);
        this.throwException(this.ERROR, 'Regular expressions not supported: ' +
            nativeRegExp);
    }
};

/**
 * Set a timeout for regular expression threads.  Unless cancelled, this will
 * terminate the thread and throw an error.
 * @param {!RegExp} nativeRegExp Regular expression (used for error message).
 * @param {!Worker} worker Thread to terminate.
 * @param {!Function} callback Async callback function to continue execution.
 * @return {number} PID of timeout.  Used to cancel if thread completes.
 */
S8Interpreter.prototype.regExpTimeout = function(nativeRegExp, worker, callback) {
    const thisInterpreter = this;
    return setTimeout(function() {
        worker.terminate();
        callback(null);
        try {
            thisInterpreter.throwException(thisInterpreter.ERROR,
                'RegExp Timeout: ' + nativeRegExp);
        } catch (e) {
            // Eat the expected Interpreter.STEP_ERROR.
        }
    }, this['REGEXP_THREAD_TIMEOUT']);
};

/**
 * Create a new data object based on a constructor's prototype.
 * @param {S8Interpreter.Object} constructor Parent constructor function,
 *     or null if scope object.
 * @return {!S8Interpreter.Object} New data object.
 */
S8Interpreter.prototype.createObject = function(constructor) {
    return this.createObjectProto(constructor &&
        constructor.properties['prototype']);
};

/**
 * Create a new data object based on a prototype.
 * @param {S8Interpreter.Object} proto Prototype object.
 * @return {!S8Interpreter.Object} New data object.
 */
S8Interpreter.prototype.createObjectProto = function(proto) {
    if (typeof proto !== 'object') {
        throw Error('Non object prototype');
    }
    const obj = new S8Interpreter.Object(proto);
    if (this.isa(obj, this.ERROR)) {
        // Record this object as being an error so that its toString function can
        // process it correctly (toString has no access to the interpreter and could
        // not otherwise determine that the object is an error).
        obj.class = 'Error';
    }
    return obj;
};

/**
 * Create a new array.
 * @return {!S8Interpreter.Object} New array.
 */
S8Interpreter.prototype.createArray = function() {
    const array = this.createObjectProto(this.ARRAY_PROTO);
    // Arrays have length.
    this.setProperty(array, 'length', 0,
        { configurable: false, enumerable: false, writable: true });
    array.class = 'Array';
    return array;
};

/**
 * Create a new function object (could become interpreted or native or async).
 * @param {number} argumentLength Number of arguments.
 * @param {boolean} isConstructor True if function can be used with 'new'.
 * @return {!S8Interpreter.Object} New function.
 * @private
 */
S8Interpreter.prototype.createFunctionBase_ = function(argumentLength,
                                                       isConstructor) {
    const func = this.createObjectProto(this.FUNCTION_PROTO);
    if (isConstructor) {
        const proto = this.createObjectProto(this.OBJECT_PROTO);
        this.setProperty(func, 'prototype', proto,
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
        this.setProperty(proto, 'constructor', func,
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    } else {
        func.illegalConstructor = true;
    }
    this.setProperty(func, 'length', argumentLength,
        S8Interpreter.READONLY_NONENUMERABLE_DESCRIPTOR);
    func.class = 'Function';
    return func;
};

/**
 * Create a new interpreted function.
 * @param {!Object} node AST node defining the function.
 * @param {!S8Interpreter.Scope} scope Parent scope.
 * @return {!S8Interpreter.Object} New function.
 */
S8Interpreter.prototype.createFunction = function(node, scope) {
    const func = this.createFunctionBase_(node['params'].length, true);
    func.parentScope = scope;
    func.node = node;
    return func;
};

/**
 * Create a new native function.
 * @param {!Function} nativeFunc JavaScript function.
 * @param {boolean} isConstructor True if function can be used with 'new'.
 * @return {!S8Interpreter.Object} New function.
 */
S8Interpreter.prototype.createNativeFunction = function(nativeFunc,
                                                        isConstructor) {
    const func = this.createFunctionBase_(nativeFunc.length, isConstructor);
    func.nativeFunc = nativeFunc;
    nativeFunc.id = this.functionCounter_++;
    return func;
};

/**
 * Create a new native asynchronous function.
 * @param {!Function} asyncFunc JavaScript function.
 * @return {!S8Interpreter.Object} New function.
 */
S8Interpreter.prototype.createAsyncFunction = function(asyncFunc) {
    const func = this.createFunctionBase_(asyncFunc.length, true);
    func.asyncFunc = asyncFunc;
    asyncFunc.id = this.functionCounter_++;
    return func;
};

/**
 * Converts from a native JavaScript object or value to a JS-Interpreter object.
 * Can handle JSON-style values, regular expressions, dates and functions.
 * Does NOT handle cycles.
 * @param {*} nativeObj The native JavaScript object to be converted.
 * @return {S8Interpreter.Value} The equivalent JS-Interpreter object.
 */
S8Interpreter.prototype.nativeToPseudo = function(nativeObj) {
    if (nativeObj instanceof S8Interpreter.Object) {
        throw Error('Object is already pseudo');
    }
    if ((typeof nativeObj !== 'object' && typeof nativeObj !== 'function') ||
        nativeObj === null) {
        return nativeObj;
    }

    if (nativeObj instanceof RegExp) {
        const pseudoRegexp = this.createObjectProto(this.REGEXP_PROTO);
        this.populateRegExp(pseudoRegexp, nativeObj);
        return pseudoRegexp;
    }

    if (nativeObj instanceof Date) {
        const pseudoDate = this.createObjectProto(this.DATE_PROTO);
        pseudoDate.data = new Date(nativeObj.valueOf());
        return pseudoDate;
    }

    if (typeof nativeObj === 'function') {
        const thisInterpreter = this;
        const wrapper = function() {
            const args = Array.prototype.slice.call(arguments).map(function(i) {
                return thisInterpreter.pseudoToNative(i);
            });
            const value = nativeObj.apply(thisInterpreter, args);
            return thisInterpreter.nativeToPseudo(value);
        };
        const prototype = Object.getOwnPropertyDescriptor(nativeObj, 'prototype');
        return this.createNativeFunction(wrapper, !!prototype);
    }

    if (Array.isArray(nativeObj)) {  // Array.
        const pseudoArray = this.createArray();
        for (var i = 0; i < nativeObj.length; i++) {
            if (i in nativeObj) {
                this.setProperty(pseudoArray, i, this.nativeToPseudo(nativeObj[i]));
            }
        }
        return pseudoArray;
    }

    // Object.
    const pseudoObj = this.createObjectProto(this.OBJECT_PROTO);
    for (let key in nativeObj) {
        this.setProperty(pseudoObj, key, this.nativeToPseudo(nativeObj[key]));
    }
    return pseudoObj;
};

/**
 * Converts from a JS-Interpreter object to native JavaScript object.
 * Can handle JSON-style values, regular expressions, and dates.
 * Does handle cycles.
 * @param {S8Interpreter.Value} pseudoObj The JS-Interpreter object to be
 * converted.
 * @param {Object=} opt_cycles Cycle detection (used in recursive calls).
 * @return {*} The equivalent native JavaScript object or value.
 */
S8Interpreter.prototype.pseudoToNative = function(pseudoObj, opt_cycles) {
    if ((typeof pseudoObj !== 'object' && typeof pseudoObj !== 'function') ||
        pseudoObj === null) {
        return pseudoObj;
    }
    if (!(pseudoObj instanceof S8Interpreter.Object)) {
        throw Error('Object is not pseudo');
    }

    if (this.isa(pseudoObj, this.REGEXP)) {  // Regular expression.
        const nativeRegExp = new RegExp(pseudoObj.data.source, pseudoObj.data.flags);
        nativeRegExp.lastIndex = pseudoObj.data.lastIndex;
        return nativeRegExp;
    }

    if (this.isa(pseudoObj, this.DATE)) {  // Date.
        return new Date(pseudoObj.data.valueOf());
    }

    const cycles = opt_cycles || {
        pseudo: [],
        native: [],
    };
    var i = cycles.pseudo.indexOf(pseudoObj);
    if (i !== -1) {
        return cycles.native[i];
    }
    cycles.pseudo.push(pseudoObj);
    let nativeObj;
    if (this.isa(pseudoObj, this.ARRAY)) {  // Array.
        nativeObj = [];
        cycles.native.push(nativeObj);
        const length = this.getProperty(pseudoObj, 'length');
        for (var i = 0; i < length; i++) {
            if (this.hasProperty(pseudoObj, i)) {
                nativeObj[i] =
                    this.pseudoToNative(this.getProperty(pseudoObj, i), cycles);
            }
        }
    } else {  // Object.
        nativeObj = {};
        cycles.native.push(nativeObj);
        let val;
        for (let key in pseudoObj.properties) {
            val = this.pseudoToNative(pseudoObj.properties[key], cycles);
            // Use defineProperty to avoid side effects if setting '__proto__'.
            Object.defineProperty(nativeObj, key,
                { value: val, writable: true, enumerable: true, configurable: true });
        }
    }
    cycles.pseudo.pop();
    cycles.native.pop();
    return nativeObj;
};

/**
 * Converts from a native JavaScript array to a JS-Interpreter array.
 * Does handle non-numeric properties (like str.match's index prop).
 * Does NOT recurse into the array's contents.
 * @param {!Array} nativeArray The JavaScript array to be converted.
 * @return {!S8Interpreter.Object} The equivalent JS-Interpreter array.
 */
S8Interpreter.prototype.arrayNativeToPseudo = function(nativeArray) {
    const pseudoArray = this.createArray();
    const props = Object.getOwnPropertyNames(nativeArray);
    for (let i = 0; i < props.length; i++) {
        this.setProperty(pseudoArray, props[i], nativeArray[props[i]]);
    }
    return pseudoArray;
};

/**
 * Converts from a JS-Interpreter array to native JavaScript array.
 * Does handle non-numeric properties (like str.match's index prop).
 * Does NOT recurse into the array's contents.
 * @param {!S8Interpreter.Object} pseudoArray The JS-Interpreter array,
 *     or JS-Interpreter object pretending to be an array.
 * @return {!Array} The equivalent native JavaScript array.
 */
S8Interpreter.prototype.arrayPseudoToNative = function(pseudoArray) {
    const nativeArray = [];
    for (let key in pseudoArray.properties) {
        nativeArray[key] = this.getProperty(pseudoArray, key);
    }
    // pseudoArray might be an object pretending to be an array.  In this case
    // it's possible that length is non-existent, invalid, or smaller than the
    // largest defined numeric property.  Set length explicitly here.
    nativeArray.length = S8Interpreter.legalArrayLength(
        this.getProperty(pseudoArray, 'length')) || 0;
    return nativeArray;
};

/**
 * Look up the prototype for this value.
 * @param {S8Interpreter.Value} value Data object.
 * @return {S8Interpreter.Object} Prototype object, null if none.
 */
S8Interpreter.prototype.getPrototype = function(value) {
    switch (typeof value) {
        case 'number':
            return this.NUMBER.properties['prototype'];
        case 'boolean':
            return this.BOOLEAN.properties['prototype'];
        case 'string':
            return this.STRING.properties['prototype'];
    }
    if (value) {
        return value.proto;
    }
    return null;
};

/**
 * Fetch a property value from a data object.
 * @param {S8Interpreter.Value} obj Data object.
 * @param {S8Interpreter.Value} name Name of property.
 * @return {S8Interpreter.Value} Property value (may be undefined).
 */
S8Interpreter.prototype.getProperty = function(obj, name) {
    if (this.getterStep_) {
        throw Error('Getter not supported in that context');
    }
    name = String(name);
    if (obj === undefined || obj === null) {
        this.throwException(this.TYPE_ERROR,
            'Cannot read property \'' + name + '\' of ' + obj);
    }
    if (typeof obj === 'object' && !(obj instanceof S8Interpreter.Object)) {
        throw TypeError('Expecting native value or pseudo object');
    }
    if (name === 'length') {
        // Special cases for magic length property.
        if (this.isa(obj, this.STRING)) {
            return String(obj).length;
        }
    } else if (name.charCodeAt(0) < 0x40) {
        // Might have numbers in there?
        // Special cases for string array indexing
        if (this.isa(obj, this.STRING)) {
            const n = S8Interpreter.legalArrayIndex(name);
            if (!isNaN(n) && n < String(obj).length) {
                return String(obj)[n];
            }
        }
    }
    do {
        if (obj.properties && name in obj.properties) {
            const getter = obj.getter[name];
            if (getter) {
                // Flag this function as being a getter and thus needing immediate
                // execution (rather than being the value of the property).
                this.getterStep_ = true;
                return getter;
            }
            return obj.properties[name];
        }
    } while ((obj = this.getPrototype(obj)));
    return undefined;
};

/**
 * Does the named property exist on a data object.
 * @param {!S8Interpreter.Object} obj Data object.
 * @param {S8Interpreter.Value} name Name of property.
 * @return {boolean} True if property exists.
 */
S8Interpreter.prototype.hasProperty = function(obj, name) {
    if (!(obj instanceof S8Interpreter.Object)) {
        throw TypeError('Primitive data type has no properties');
    }
    name = String(name);
    if (name === 'length' && this.isa(obj, this.STRING)) {
        return true;
    }
    if (this.isa(obj, this.STRING)) {
        const n = S8Interpreter.legalArrayIndex(name);
        if (!isNaN(n) && n < String(obj).length) {
            return true;
        }
    }
    do {
        if (obj.properties && name in obj.properties) {
            return true;
        }
    } while ((obj = this.getPrototype(obj)));
    return false;
};

/**
 * Set a property value on a data object.
 * @param {S8Interpreter.Value} obj Data object.
 * @param {S8Interpreter.Value} name Name of property.
 * @param {S8Interpreter.Value} value New property value.
 *     Use Interpreter.VALUE_IN_DESCRIPTOR if value is handled by
 *     descriptor instead.
 * @param {Object=} opt_descriptor Optional descriptor object.
 * @return {!S8Interpreter.Object|undefined} Returns a setter function if one
 *     needs to be called, otherwise undefined.
 */
S8Interpreter.prototype.setProperty = function(obj, name, value, opt_descriptor) {
    if (this.setterStep_) {
        // Getter from previous call to setProperty was not handled.
        throw Error('Setter not supported in that context');
    }
    name = String(name);
    if (obj === undefined || obj === null) {
        this.throwException(this.TYPE_ERROR,
            'Cannot set property \'' + name + '\' of ' + obj);
    }
    if (typeof obj === 'object' && !(obj instanceof S8Interpreter.Object)) {
        throw TypeError('Expecting native value or pseudo object');
    }
    if (opt_descriptor && ('get' in opt_descriptor || 'set' in opt_descriptor) &&
        ('value' in opt_descriptor || 'writable' in opt_descriptor)) {
        this.throwException(this.TYPE_ERROR, 'Invalid property descriptor. ' +
            'Cannot both specify accessors and a value or writable attribute');
    }
    const strict = !this.stateStack || this.getScope().strict;
    if (!(obj instanceof S8Interpreter.Object)) {
        if (strict) {
            this.throwException(this.TYPE_ERROR, 'Can\'t create property \'' + name +
                '\' on \'' + obj + '\'');
        }
        return;
    }
    if (this.isa(obj, this.STRING)) {
        const n = S8Interpreter.legalArrayIndex(name);
        if (name === 'length' || (!isNaN(n) && n < String(obj).length)) {
            // Can't set length or letters on String objects.
            if (strict) {
                this.throwException(this.TYPE_ERROR, 'Cannot assign to read only ' +
                    'property \'' + name + '\' of String \'' + obj.data + '\'');
            }
            return;
        }
    }
    if (obj.class === 'Array') {
        // Arrays have a magic length variable that is bound to the elements.
        const length = obj.properties.length;
        let i;
        if (name === 'length') {
            // Delete elements if length is smaller.
            if (opt_descriptor) {
                if (!('value' in opt_descriptor)) {
                    return;
                }
                value = opt_descriptor.value;
            }
            value = S8Interpreter.legalArrayLength(value);
            if (isNaN(value)) {
                this.throwException(this.RANGE_ERROR, 'Invalid array length');
            }
            if (value < length) {
                for (i in obj.properties) {
                    i = S8Interpreter.legalArrayIndex(i);
                    if (!isNaN(i) && value <= i) {
                        delete obj.properties[i];
                    }
                }
            }
        } else if (!isNaN(i = S8Interpreter.legalArrayIndex(name))) {
            // Increase length if this index is larger.
            obj.properties.length = Math.max(length, i + 1);
        }
    }
    if (obj.preventExtensions && !(name in obj.properties)) {
        if (strict) {
            this.throwException(this.TYPE_ERROR, 'Can\'t add property \'' + name +
                '\', object is not extensible');
        }
        return;
    }
    if (opt_descriptor) {
        // Define the property.
        if ('get' in opt_descriptor) {
            if (opt_descriptor.get) {
                obj.getter[name] = opt_descriptor.get;
            } else {
                delete obj.getter[name];
            }
        }
        if ('set' in opt_descriptor) {
            if (opt_descriptor.set) {
                obj.setter[name] = opt_descriptor.set;
            } else {
                delete obj.setter[name];
            }
        }
        const descriptor = {};
        if ('configurable' in opt_descriptor) {
            descriptor.configurable = opt_descriptor.configurable;
        }
        if ('enumerable' in opt_descriptor) {
            descriptor.enumerable = opt_descriptor.enumerable;
        }
        if ('writable' in opt_descriptor) {
            descriptor.writable = opt_descriptor.writable;
            delete obj.getter[name];
            delete obj.setter[name];
        }
        if ('value' in opt_descriptor) {
            descriptor.value = opt_descriptor.value;
            delete obj.getter[name];
            delete obj.setter[name];
        } else if (value !== S8Interpreter.VALUE_IN_DESCRIPTOR) {
            descriptor.value = value;
            delete obj.getter[name];
            delete obj.setter[name];
        }
        try {
            Object.defineProperty(obj.properties, name, descriptor);
        } catch (e) {
            this.throwException(this.TYPE_ERROR, 'Cannot redefine property: ' + name);
        }
    } else {
        // Set the property.
        if (value === S8Interpreter.VALUE_IN_DESCRIPTOR) {
            throw ReferenceError('Value not specified.');
        }
        // Determine the parent (possibly self) where the property is defined.
        let defObj = obj;
        while (!(name in defObj.properties)) {
            defObj = this.getPrototype(defObj);
            if (!defObj) {
                // This is a new property.
                defObj = obj;
                break;
            }
        }
        if (defObj.setter && defObj.setter[name]) {
            this.setterStep_ = true;
            return defObj.setter[name];
        }
        if (defObj.getter && defObj.getter[name]) {
            if (strict) {
                this.throwException(this.TYPE_ERROR, 'Cannot set property \'' + name +
                    '\' of object \'' + obj + '\' which only has a getter');
            }
        } else {
            // No setter, simple assignment.
            try {
                obj.properties[name] = value;
            } catch (e) {
                if (strict) {
                    this.throwException(this.TYPE_ERROR, 'Cannot assign to read only ' +
                        'property \'' + name + '\' of object \'' + obj + '\'');
                }
            }
        }
    }
};

/**
 * Convenience method for adding a native function as a non-enumerable property
 * onto an object's prototype.
 * @param {!S8Interpreter.Object} obj Data object.
 * @param {S8Interpreter.Value} name Name of property.
 * @param {!Function} wrapper Function object.
 */
S8Interpreter.prototype.setNativeFunctionPrototype =
    function(obj, name, wrapper) {
        this.setProperty(obj.properties['prototype'], name,
            this.createNativeFunction(wrapper, false),
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    };

/**
 * Convenience method for adding an async function as a non-enumerable property
 * onto an object's prototype.
 * @param {!S8Interpreter.Object} obj Data object.
 * @param {S8Interpreter.Value} name Name of property.
 * @param {!Function} wrapper Function object.
 */
S8Interpreter.prototype.setAsyncFunctionPrototype =
    function(obj, name, wrapper) {
        this.setProperty(obj.properties['prototype'], name,
            this.createAsyncFunction(wrapper),
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    };

/**
 * Returns the current scope from the stateStack.
 * @return {!S8Interpreter.Scope} Current scope.
 */
S8Interpreter.prototype.getScope = function() {
    const scope = this.stateStack[this.stateStack.length - 1].scope;
    if (!scope) {
        throw Error('No scope found.');
    }
    return scope;
};

/**
 * Create a new scope dictionary.
 * @param {!Object} node AST node defining the scope container
 *     (e.g. a function).
 * @param {S8Interpreter.Scope} parentScope Scope to link to.
 * @return {!S8Interpreter.Scope} New scope.
 */
S8Interpreter.prototype.createScope = function(node, parentScope) {
    // Determine if this scope starts with `use strict`.
    let strict = false;
    if (parentScope && parentScope.strict) {
        strict = true;
    } else {
        const firstNode = node['body'] && node['body'][0];
        if (firstNode && firstNode.expression &&
            firstNode.expression['type'] === 'Literal' &&
            firstNode.expression.value === 'use strict') {
            strict = true;
        }
    }
    const object = this.createObjectProto(null);
    const scope = new S8Interpreter.Scope(parentScope, strict, object);
    if (!parentScope) {
        this.initGlobal(scope.object);
    }
    this.populateScope_(node, scope);
    return scope;
};

/**
 * Create a new special scope dictionary. Similar to createScope(), but
 * doesn't assume that the scope is for a function body.
 * This is used for 'catch' clauses and 'with' statements.
 * @param {!S8Interpreter.Scope} parentScope Scope to link to.
 * @param {S8Interpreter.Object=} opt_object Optional object to transform into
 *     scope.
 * @return {!S8Interpreter.Scope} New scope.
 */
S8Interpreter.prototype.createSpecialScope = function(parentScope, opt_object) {
    if (!parentScope) {
        throw Error('parentScope required');
    }
    const object = opt_object || this.createObjectProto(null);
    return new S8Interpreter.Scope(parentScope, parentScope.strict, object);
};

/**
 * Retrieves a value from the scope chain.
 * @param {string} name Name of variable.
 * @return {S8Interpreter.Value} Any value.
 *   May be flagged as being a getter and thus needing immediate execution
 *   (rather than being the value of the property).
 */
S8Interpreter.prototype.getValueFromScope = function(name) {
    let scope = this.getScope();
    while (scope && scope !== this.globalScope) {
        if (name in scope.object.properties) {
            return scope.object.properties[name];
        }
        scope = scope.parentScope;
    }
    // The root scope is also an object which has inherited properties and
    // could also have getters.
    if (scope === this.globalScope && this.hasProperty(scope.object, name)) {
        return this.getProperty(scope.object, name);
    }
    // Typeof operator is unique: it can safely look at non-defined variables.
    const prevNode = this.stateStack[this.stateStack.length - 1].node;
    if (prevNode['type'] === 'UnaryExpression' &&
        prevNode['operator'] === 'typeof') {
        return undefined;
    }
    this.throwException(this.REFERENCE_ERROR, name + ' is not defined');
};

/**
 * Sets a value to the current scope.
 * @param {string} name Name of variable.
 * @param {S8Interpreter.Value} value Value.
 * @return {!S8Interpreter.Object|undefined} Returns a setter function if one
 *     needs to be called, otherwise undefined.
 */
S8Interpreter.prototype.setValueToScope = function(name, value) {
    let scope = this.getScope();
    const strict = scope.strict;
    while (scope && scope !== this.globalScope) {
        if (name in scope.object.properties) {
            scope.object.properties[name] = value;
            return undefined;
        }
        scope = scope.parentScope;
    }
    // The root scope is also an object which has readonly properties and
    // could also have setters.
    if (scope === this.globalScope &&
        (!strict || this.hasProperty(scope.object, name))) {
        return this.setProperty(scope.object, name, value);
    }
    this.throwException(this.REFERENCE_ERROR, name + ' is not defined');
};

/**
 * Create a new scope for the given node.
 * @param {!Object} node AST node (program or function).
 * @param {!S8Interpreter.Scope} scope Scope dictionary to populate.
 * @private
 */
S8Interpreter.prototype.populateScope_ = function(node, scope) {
    if (node['type'] === 'VariableDeclaration') {
        for (var i = 0; i < node['declarations'].length; i++) {
            this.setProperty(scope.object, node['declarations'][i]['id']['name'],
                undefined, S8Interpreter.VARIABLE_DESCRIPTOR);
        }
    } else if (node['type'] === 'FunctionDeclaration') {
        this.setProperty(scope.object, node['id']['name'],
            this.createFunction(node, scope), S8Interpreter.VARIABLE_DESCRIPTOR);
        return;  // Do not recurse into function.
    } else if (node['type'] === 'FunctionExpression') {
        return;  // Do not recurse into function.
    } else if (node['type'] === 'ExpressionStatement') {
        return;  // Expressions can't contain variable/function declarations.
    }
    const nodeClass = node['constructor'];
    for (let name in node) {
        const prop = node[name];
        if (prop && typeof prop === 'object') {
            if (Array.isArray(prop)) {
                for (var i = 0; i < prop.length; i++) {
                    if (prop[i] && prop[i].constructor === nodeClass) {
                        this.populateScope_(prop[i], scope);
                    }
                }
            } else {
                if (prop.constructor === nodeClass) {
                    this.populateScope_(prop, scope);
                }
            }
        }
    }
};

/**
 * Is the current state directly being called with as a construction with 'new'.
 * @return {boolean} True if 'new foo()', false if 'foo()'.
 */
S8Interpreter.prototype.calledWithNew = function() {
    return this.stateStack[this.stateStack.length - 1].isConstructor;
};

/**
 * Gets a value from the scope chain or from an object property.
 * @param {!Array} ref Name of variable or object/propname tuple.
 * @return {S8Interpreter.Value} Any value.
 *   May be flagged as being a getter and thus needing immediate execution
 *   (rather than being the value of the property).
 */
S8Interpreter.prototype.getValue = function(ref) {
    if (ref[0] === S8Interpreter.SCOPE_REFERENCE) {
        // A null/varname variable lookup.
        return this.getValueFromScope(ref[1]);
    } else {
        // An obj/prop components tuple (foo.bar).
        return this.getProperty(ref[0], ref[1]);
    }
};

/**
 * Sets a value to the scope chain or to an object property.
 * @param {!Array} ref Name of variable or object/propname tuple.
 * @param {S8Interpreter.Value} value Value.
 * @return {!S8Interpreter.Object|undefined} Returns a setter function if one
 *     needs to be called, otherwise undefined.
 */
S8Interpreter.prototype.setValue = function(ref, value) {
    if (ref[0] === S8Interpreter.SCOPE_REFERENCE) {
        // A null/varname variable lookup.
        return this.setValueToScope(ref[1], value);
    } else {
        // An obj/prop components tuple (foo.bar).
        return this.setProperty(ref[0], ref[1], value);
    }
};

/**
 * Throw an exception in the interpreter that can be handled by an
 * interpreter try/catch statement.  If unhandled, a real exception will
 * be thrown.  Can be called with either an error class and a message, or
 * with an actual object to be thrown.
 * @param {!S8Interpreter.Object|S8Interpreter.Value} errorClass Type of error
 *   (if message is provided) or the value to throw (if no message).
 * @param {string=} opt_message Message being thrown.
 */
S8Interpreter.prototype.throwException = function(errorClass, opt_message) {
    if (opt_message === undefined) {
        var error = errorClass;  // This is a value to throw, not an error class.
    } else {
        var error = this.createObject(errorClass);
        this.setProperty(error, 'message', opt_message,
            S8Interpreter.NONENUMERABLE_DESCRIPTOR);
    }
    this.unwind(S8Interpreter.Completion.THROW, error, undefined);
    // Abort anything related to the current step.
    throw S8Interpreter.STEP_ERROR;
};

/**
 * Unwind the stack to the innermost relevant enclosing TryStatement,
 * For/ForIn/WhileStatement or Call/NewExpression.  If this results in
 * the stack being completely unwound the thread will be terminated
 * and the appropriate error being thrown.
 * @param {S8Interpreter.Completion} type Completion type.
 * @param {S8Interpreter.Value} value Value computed, returned or thrown.
 * @param {string|undefined} label Target label for break or return.
 */
S8Interpreter.prototype.unwind = function(type, value, label) {
    if (type === S8Interpreter.Completion.NORMAL) {
        throw TypeError('Should not unwind for NORMAL completions');
    }

    loop: for (const stack = this.stateStack; stack.length > 0; stack.pop()) {
        const state = stack[stack.length - 1];
        switch (state.node['type']) {
            case 'TryStatement':
                state.cv = { type: type, value: value, label: label };
                return;
            case 'CallExpression':
            case 'NewExpression':
                if (type === S8Interpreter.Completion.RETURN) {
                    state.value = value;
                    return;
                } else if (type !== S8Interpreter.Completion.THROW) {
                    throw Error('Unsynatctic break/continue not rejected by Acorn');
                }
                break;
            case 'Program':
                // Don't pop the stateStack.
                // Leave the root scope on the tree in case the program is appended to.
                state.done = true;
                break loop;
        }
        if (type === S8Interpreter.Completion.BREAK) {
            if (label ? (state.labels && state.labels.indexOf(label) !== -1) :
                (state.isLoop || state.isSwitch)) {
                stack.pop();
                return;
            }
        } else if (type === S8Interpreter.Completion.CONTINUE) {
            if (label ? (state.labels && state.labels.indexOf(label) !== -1) :
                state.isLoop) {
                return;
            }
        }
    }

    // Unhandled completion.  Throw a real error.
    let realError;
    if (this.isa(value, this.ERROR)) {
        const errorTable = {
            'EvalError': EvalError,
            'RangeError': RangeError,
            'ReferenceError': ReferenceError,
            'SyntaxError': SyntaxError,
            'TypeError': TypeError,
            'URIError': URIError,
        };
        const name = String(this.getProperty(value, 'name'));
        const message = this.getProperty(value, 'message').valueOf();
        const errorConstructor = errorTable[name] || Error;
        realError = errorConstructor(message);
    } else {
        realError = String(value);
    }
    throw realError;
};

/**
 * Create a call to a getter function.
 * @param {!S8Interpreter.Object} func Function to execute.
 * @param {!S8Interpreter.Object|!Array} left
 *     Name of variable or object/propname tuple.
 * @private
 */
S8Interpreter.prototype.createGetter_ = function(func, left) {
    if (!this.getterStep_) {
        throw Error('Unexpected call to createGetter');
    }
    // Clear the getter flag.
    this.getterStep_ = false;
    // Normally `this` will be specified as the object component (o.x).
    // Sometimes `this` is explicitly provided (o).
    const funcThis = Array.isArray(left) ? left[0] : left;
    const node = new this.nodeConstructor({ options: {} });
    node['type'] = 'CallExpression';
    const state = new S8Interpreter.State(node,
        this.stateStack[this.stateStack.length - 1].scope);
    state.doneCallee_ = true;
    state.funcThis_ = funcThis;
    state.func_ = func;
    state.doneArgs_ = true;
    state.arguments_ = [];
    return state;
};

/**
 * Create a call to a setter function.
 * @param {!S8Interpreter.Object} func Function to execute.
 * @param {!S8Interpreter.Object|!Array} left
 *     Name of variable or object/propname tuple.
 * @param {S8Interpreter.Value} value Value to set.
 * @private
 */
S8Interpreter.prototype.createSetter_ = function(func, left, value) {
    if (!this.setterStep_) {
        throw Error('Unexpected call to createSetter');
    }
    // Clear the setter flag.
    this.setterStep_ = false;
    // Normally `this` will be specified as the object component (o.x).
    // Sometimes `this` is implicitly the global object (x).
    const funcThis = Array.isArray(left) ? left[0] : this.globalObject;
    const node = new this.nodeConstructor({ options: {} });
    node['type'] = 'CallExpression';
    const state = new S8Interpreter.State(node,
        this.stateStack[this.stateStack.length - 1].scope);
    state.doneCallee_ = true;
    state.funcThis_ = funcThis;
    state.func_ = func;
    state.doneArgs_ = true;
    state.arguments_ = [value];
    return state;
};

/**
 * Typedef for JS values.
 * @typedef {!S8Interpreter.Object|boolean|number|string|undefined|null}
 */
S8Interpreter.Value;

/**
 * Class for a state.
 * @param {!Object} node AST node for the state.
 * @param {!S8Interpreter.Scope} scope Scope object for the state.
 * @constructor
 */
S8Interpreter.State = function(node, scope) {
    this.node = node;
    this.scope = scope;
};

/**
 * Class for a scope.
 * @param {S8Interpreter.Scope} parentScope Parent scope.
 * @param {boolean} strict True if "use strict".
 * @param {!S8Interpreter.Object} object Object containing scope's variables.
 * @struct
 * @constructor
 */
S8Interpreter.Scope = function(parentScope, strict, object) {
    this.parentScope = parentScope;
    this.strict = strict;
    this.object = object;
};

/**
 * Class for an object.
 * @param {S8Interpreter.Object} proto Prototype object or null.
 * @constructor
 */
S8Interpreter.Object = function(proto) {
    this.getter = Object.create(null);
    this.setter = Object.create(null);
    this.properties = Object.create(null);
    this.proto = proto;
};

/** @type {S8Interpreter.Object} */
S8Interpreter.Object.prototype.proto = null;

/** @type {string} */
S8Interpreter.Object.prototype.class = 'Object';

/** @type {Date|RegExp|boolean|number|string|null} */
S8Interpreter.Object.prototype.data = null;

/**
 * Convert this object into a string.
 * @return {string} String value.
 * @override
 */
S8Interpreter.Object.prototype.toString = function() {
    if (!(this instanceof S8Interpreter.Object)) {
        // Primitive value.
        return String(this);
    }

    if (this.class === 'Array') {
        // Array contents must not have cycles.
        var cycles = S8Interpreter.toStringCycles_;
        cycles.push(this);
        try {
            var strs = [];
            for (let i = 0; i < this.properties.length; i++) {
                const value = this.properties[i];
                strs[i] = ((value instanceof S8Interpreter.Object) &&
                    cycles.indexOf(value) !== -1) ? '...' : value;
            }
        } finally {
            cycles.pop();
        }
        return strs.join(',');
    }

    if (this.class === 'Error') {
        // Error name and message properties must not have cycles.
        var cycles = S8Interpreter.toStringCycles_;
        if (cycles.indexOf(this) !== -1) {
            return '[object Error]';
        }
        let name, message;
        // Bug: Does not support getters and setters for name or message.
        var obj = this;
        do {
            if ('name' in obj.properties) {
                name = obj.properties['name'];
                break;
            }
        } while ((obj = obj.proto));
        var obj = this;
        do {
            if ('message' in obj.properties) {
                message = obj.properties['message'];
                break;
            }
        } while ((obj = obj.proto));
        cycles.push(this);
        try {
            name = name && String(name);
            message = message && String(message);
        } finally {
            cycles.pop();
        }
        return message ? name + ': ' + message : String(name);
    }

    if (this.data !== null) {
        // RegExp, Date, and boxed primitives.
        return String(this.data);
    }

    return '[object ' + this.class + ']';
};

/**
 * Return the object's value.
 * @return {S8Interpreter.Value} Value.
 * @override
 */
S8Interpreter.Object.prototype.valueOf = function() {
    if (this.data === undefined || this.data === null ||
        this.data instanceof RegExp) {
        return this;  // An Object, RegExp, or primitive.
    }
    if (this.data instanceof Date) {
        return this.data.valueOf();  // Milliseconds.
    }
    return /** @type {(boolean|number|string)} */ (this.data);  // Boxed primitive.
};

///////////////////////////////////////////////////////////////////////////////
// Functions to handle each node type.
///////////////////////////////////////////////////////////////////////////////

S8Interpreter.prototype['stepArrayExpression'] = function(stack, state, node) {
    const elements = node['elements'];
    let n = state.n_ || 0;
    if (!state.array_) {
        state.array_ = this.createArray();
        state.array_.properties.length = elements.length;
    } else {
        this.setProperty(state.array_, n, state.value);
        n++;
    }
    while (n < elements.length) {
        // Skip missing elements - they're not defined, not undefined.
        if (elements[n]) {
            state.n_ = n;
            return new S8Interpreter.State(elements[n], state.scope);
        }
        n++;
    }
    stack.pop();
    stack[stack.length - 1].value = state.array_;
};

S8Interpreter.prototype['stepAssignmentExpression'] =
    function(stack, state, node) {
        if (!state.doneLeft_) {
            state.doneLeft_ = true;
            const nextState = new S8Interpreter.State(node['left'], state.scope);
            nextState.components = true;
            return nextState;
        }
        if (!state.doneRight_) {
            if (!state.leftReference_) {
                state.leftReference_ = state.value;
            }
            if (state.doneGetter_) {
                state.leftValue_ = state.value;
            }
            if (!state.doneGetter_ && node['operator'] !== '=') {
                const leftValue = this.getValue(state.leftReference_);
                state.leftValue_ = leftValue;
                if (this.getterStep_) {
                    // Call the getter function.
                    state.doneGetter_ = true;
                    const func = /** @type {!S8Interpreter.Object} */ (leftValue);
                    return this.createGetter_(func, state.leftReference_);
                }
            }
            state.doneRight_ = true;
            return new S8Interpreter.State(node['right'], state.scope);
        }
        if (state.doneSetter_) {
            // Return if setter function.
            // Setter method on property has completed.
            // Ignore its return value, and use the original set value instead.
            stack.pop();
            stack[stack.length - 1].value = state.setterValue_;
            return;
        }
        let value = state.leftValue_;
        const rightValue = state.value;
        switch (node['operator']) {
            case '=':
                value = rightValue;
                break;
            case '+=':
                value += rightValue;
                break;
            case '-=':
                value -= rightValue;
                break;
            case '*=':
                value *= rightValue;
                break;
            case '/=':
                value /= rightValue;
                break;
            case '%=':
                value %= rightValue;
                break;
            case '<<=':
                value <<= rightValue;
                break;
            case '>>=':
                value >>= rightValue;
                break;
            case '>>>=':
                value >>>= rightValue;
                break;
            case '&=':
                value &= rightValue;
                break;
            case '^=':
                value ^= rightValue;
                break;
            case '|=':
                value |= rightValue;
                break;
            default:
                throw SyntaxError('Unknown assignment expression: ' + node['operator']);
        }
        const setter = this.setValue(state.leftReference_, value);
        if (setter) {
            state.doneSetter_ = true;
            state.setterValue_ = value;
            return this.createSetter_(setter, state.leftReference_, value);
        }
        // Return if no setter function.
        stack.pop();
        stack[stack.length - 1].value = value;
    };

S8Interpreter.prototype['stepBinaryExpression'] = function(stack, state, node) {
    if (!state.doneLeft_) {
        state.doneLeft_ = true;
        return new S8Interpreter.State(node['left'], state.scope);
    }
    if (!state.doneRight_) {
        state.doneRight_ = true;
        state.leftValue_ = state.value;
        return new S8Interpreter.State(node['right'], state.scope);
    }
    stack.pop();
    const leftValue = state.leftValue_;
    const rightValue = state.value;
    let value;
    switch (node['operator']) {
        case '==':
            value = leftValue == rightValue;
            break;
        case '!=':
            value = leftValue != rightValue;
            break;
        case '===':
            value = leftValue === rightValue;
            break;
        case '!==':
            value = leftValue !== rightValue;
            break;
        case '>':
            value = leftValue > rightValue;
            break;
        case '>=':
            value = leftValue >= rightValue;
            break;
        case '<':
            value = leftValue < rightValue;
            break;
        case '<=':
            value = leftValue <= rightValue;
            break;
        case '+':
            value = leftValue + rightValue;
            break;
        case '-':
            value = leftValue - rightValue;
            break;
        case '*':
            value = leftValue * rightValue;
            break;
        case '/':
            value = leftValue / rightValue;
            break;
        case '%':
            value = leftValue % rightValue;
            break;
        case '&':
            value = leftValue & rightValue;
            break;
        case '|':
            value = leftValue | rightValue;
            break;
        case '^':
            value = leftValue ^ rightValue;
            break;
        case '<<':
            value = leftValue << rightValue;
            break;
        case '>>':
            value = leftValue >> rightValue;
            break;
        case '>>>':
            value = leftValue >>> rightValue;
            break;
        case 'in':
            if (!(rightValue instanceof S8Interpreter.Object)) {
                this.throwException(this.TYPE_ERROR,
                    '\'in\' expects an object, not \'' + rightValue + '\'');
            }
            value = this.hasProperty(rightValue, leftValue);
            break;
        case 'instanceof':
            if (!this.isa(rightValue, this.FUNCTION)) {
                this.throwException(this.TYPE_ERROR,
                    'Right-hand side of instanceof is not an object');
            }
            value = (leftValue instanceof S8Interpreter.Object) ?
                this.isa(leftValue, rightValue) : false;
            break;
        default:
            throw SyntaxError('Unknown binary operator: ' + node['operator']);
    }
    stack[stack.length - 1].value = value;
};

S8Interpreter.prototype['stepBlockStatement'] = function(stack, state, node) {
    const n = state.n_ || 0;
    const expression = node['body'][n];
    if (expression) {
        state.n_ = n + 1;
        return new S8Interpreter.State(expression, state.scope);
    }
    stack.pop();
};

S8Interpreter.prototype['stepBreakStatement'] = function(stack, state, node) {
    const label = node['label'] && node['label']['name'];
    this.unwind(S8Interpreter.Completion.BREAK, undefined, label);
};

S8Interpreter.prototype['stepCallExpression'] = function(stack, state, node) {
    if (!state.doneCallee_) {
        state.doneCallee_ = 1;
        // Components needed to determine value of `this`.
        const nextState = new S8Interpreter.State(node['callee'], state.scope);
        nextState.components = true;
        return nextState;
    }
    if (state.doneCallee_ === 1) {
        // Determine value of the function.
        state.doneCallee_ = 2;
        var func = state.value;
        if (Array.isArray(func)) {
            state.func_ = this.getValue(func);
            if (func[0] === S8Interpreter.SCOPE_REFERENCE) {
                // (Globally or locally) named function.  Is it named 'eval'?
                state.directEval_ = (func[1] === 'eval');
            } else {
                // Method function, `this` is object (ignored if invoked as `new`).
                state.funcThis_ = func[0];
            }
            func = state.func_;
            if (this.getterStep_) {
                // Call the getter function.
                state.doneCallee_ = 1;
                return this.createGetter_(/** @type {!S8Interpreter.Object} */ (func),
                    state.value);
            }
        } else {
            // Already evaluated function: (function(){...})();
            state.func_ = func;
        }
        state.arguments_ = [];
        state.n_ = 0;
    }
    var func = state.func_;
    if (!state.doneArgs_) {
        if (state.n_ !== 0) {
            state.arguments_.push(state.value);
        }
        if (node['arguments'][state.n_]) {
            return new S8Interpreter.State(node['arguments'][state.n_++], state.scope);
        }
        // Determine value of `this` in function.
        if (node['type'] === 'NewExpression') {
            if (func.illegalConstructor) {
                // Illegal: new escape();
                this.throwException(this.TYPE_ERROR, func + ' is not a constructor');
            }
            // Constructor, `this` is new object.
            if (func === this.ARRAY) {
                state.funcThis_ = this.createArray();
            } else {
                let proto = func.properties['prototype'];
                if (typeof proto !== 'object' || proto === null) {
                    // Non-object prototypes default to `Object.prototype`.
                    proto = this.OBJECT_PROTO;
                }
                state.funcThis_ = this.createObjectProto(proto);
            }
            state.isConstructor = true;
        } else if (state.funcThis_ === undefined) {
            // Global function, `this` is global object (or `undefined` if strict).
            state.funcThis_ = state.scope.strict ? undefined : this.globalObject;
        }
        state.doneArgs_ = true;
    }
    if (!state.doneExec_) {
        state.doneExec_ = true;
        if (!(func instanceof S8Interpreter.Object)) {
            this.throwException(this.TYPE_ERROR, func + ' is not a function');
        }
        const funcNode = func.node;
        if (funcNode) {
            var scope = this.createScope(funcNode['body'], func.parentScope);
            // Add all arguments.
            for (var i = 0; i < funcNode['params'].length; i++) {
                const paramName = funcNode['params'][i]['name'];
                const paramValue = state.arguments_.length > i ? state.arguments_[i] :
                    undefined;
                this.setProperty(scope.object, paramName, paramValue);
            }
            // Build arguments variable.
            const argsList = this.createArray();
            for (var i = 0; i < state.arguments_.length; i++) {
                this.setProperty(argsList, i, state.arguments_[i]);
            }
            this.setProperty(scope.object, 'arguments', argsList);
            // Add the function's name (var x = function foo(){};)
            const name = funcNode['id'] && funcNode['id']['name'];
            if (name) {
                this.setProperty(scope.object, name, func);
            }
            this.setProperty(scope.object, 'this', state.funcThis_,
                S8Interpreter.READONLY_DESCRIPTOR);
            state.value = undefined;  // Default value if no explicit return.
            return new S8Interpreter.State(funcNode['body'], scope);
        } else if (func.eval) {
            const code = state.arguments_[0];
            if (typeof code !== 'string') {
                // JS does not parse String objects:
                // eval(new String('1 + 1')) -> '1 + 1'
                state.value = code;
            } else {
                try {
                    var ast = acorn.parse(String(code), S8Interpreter.PARSE_OPTIONS);
                } catch (e) {
                    // Acorn threw a SyntaxError.  Rethrow as a trappable error.
                    this.throwException(this.SYNTAX_ERROR, 'Invalid code: ' + e.message);
                }
                const evalNode = new this.nodeConstructor({ options: {} });
                evalNode['type'] = 'EvalProgram_';
                evalNode['body'] = ast['body'];
                S8Interpreter.stripLocations_(evalNode, node['start'], node['end']);
                // Create new scope and update it with definitions in eval().
                var scope = state.directEval_ ? state.scope : this.globalScope;
                if (scope.strict) {
                    // Strict mode get its own scope in eval.
                    scope = this.createScope(ast, scope);
                } else {
                    // Non-strict mode pollutes the current scope.
                    this.populateScope_(ast, scope);
                }
                this.value = undefined;  // Default value if no code.
                return new S8Interpreter.State(evalNode, scope);
            }
        } else if (func.nativeFunc) {
            state.value = func.nativeFunc.apply(state.funcThis_, state.arguments_);
        } else if (func.asyncFunc) {
            const thisInterpreter = this;
            const callback = function(value) {
                state.value = value;
                thisInterpreter.paused_ = false;
            };
            // Force the argument lengths to match, then append the callback.
            const argLength = func.asyncFunc.length - 1;
            const argsWithCallback = state.arguments_.concat(
                new Array(argLength)).slice(0, argLength);
            argsWithCallback.push(callback);
            this.paused_ = true;
            func.asyncFunc.apply(state.funcThis_, argsWithCallback);
            return;
        } else {
            /* A child of a function is a function but is not callable.  For example:
      var F = function() {};
      F.prototype = escape;
      var f = new F();
      f();
      */
            this.throwException(this.TYPE_ERROR, func.class + ' is not callable');
        }
    } else {
        // Execution complete.  Put the return value on the stack.
        stack.pop();
        if (state.isConstructor && typeof state.value !== 'object') {
            // Normal case for a constructor is to use the `this` value.
            stack[stack.length - 1].value = state.funcThis_;
        } else {
            // Non-constructors or constructions explicitly returning objects use
            // the return value.
            stack[stack.length - 1].value = state.value;
        }
    }
};

S8Interpreter.prototype['stepCatchClause'] = function(stack, state, node) {
    if (!state.done_) {
        state.done_ = true;
        // Create an empty scope.
        const scope = this.createSpecialScope(state.scope);
        // Add the argument.
        this.setProperty(scope.object, node['param']['name'], state.throwValue);
        // Execute catch clause.
        return new S8Interpreter.State(node['body'], scope);
    } else {
        stack.pop();
    }
};

S8Interpreter.prototype['stepConditionalExpression'] =
    function(stack, state, node) {
        const mode = state.mode_ || 0;
        if (mode === 0) {
            state.mode_ = 1;
            return new S8Interpreter.State(node['test'], state.scope);
        }
        if (mode === 1) {
            state.mode_ = 2;
            const value = Boolean(state.value);
            if (value && node['consequent']) {
                // Execute `if` block.
                return new S8Interpreter.State(node['consequent'], state.scope);
            } else if (!value && node['alternate']) {
                // Execute `else` block.
                return new S8Interpreter.State(node['alternate'], state.scope);
            }
            // eval('1;if(false){2}') -> undefined
            this.value = undefined;
        }
        stack.pop();
        if (node['type'] === 'ConditionalExpression') {
            stack[stack.length - 1].value = state.value;
        }
    };

S8Interpreter.prototype['stepContinueStatement'] = function(stack, state, node) {
    const label = node['label'] && node['label']['name'];
    this.unwind(S8Interpreter.Completion.CONTINUE, undefined, label);
};

S8Interpreter.prototype['stepDebuggerStatement'] = function(stack, state, node) {
    // Do nothing.  May be overridden by developers.
    stack.pop();
};

S8Interpreter.prototype['stepDoWhileStatement'] = function(stack, state, node) {
    if (node['type'] === 'DoWhileStatement' && state.test_ === undefined) {
        // First iteration of do/while executes without checking test.
        state.value = true;
        state.test_ = true;
    }
    if (!state.test_) {
        state.test_ = true;
        return new S8Interpreter.State(node['test'], state.scope);
    }
    if (!state.value) {  // Done, exit loop.
        stack.pop();
    } else if (node['body']) {  // Execute the body.
        state.test_ = false;
        state.isLoop = true;
        return new S8Interpreter.State(node['body'], state.scope);
    }
};

S8Interpreter.prototype['stepEmptyStatement'] = function(stack, state, node) {
    stack.pop();
};

S8Interpreter.prototype['stepEvalProgram_'] = function(stack, state, node) {
    const n = state.n_ || 0;
    const expression = node['body'][n];
    if (expression) {
        state.n_ = n + 1;
        return new S8Interpreter.State(expression, state.scope);
    }
    stack.pop();
    stack[stack.length - 1].value = this.value;
};

S8Interpreter.prototype['stepExpressionStatement'] = function(stack, state, node) {
    if (!state.done_) {
        state.done_ = true;
        return new S8Interpreter.State(node['expression'], state.scope);
    }
    stack.pop();
    // Save this value to interpreter.value for use as a return value if
    // this code is inside an eval function.
    this.value = state.value;
};

S8Interpreter.prototype['stepForInStatement'] = function(stack, state, node) {
    // First, initialize a variable if exists.  Only do so once, ever.
    if (!state.doneInit_) {
        state.doneInit_ = true;
        if (node['left']['declarations'] &&
            node['left']['declarations'][0]['init']) {
            if (state.scope.strict) {
                this.throwException(this.SYNTAX_ERROR,
                    'for-in loop variable declaration may not have an initializer.');
            }
            // Variable initialization: for (var x = 4 in y)
            return new S8Interpreter.State(node['left'], state.scope);
        }
    }
    // Second, look up the object.  Only do so once, ever.
    if (!state.doneObject_) {
        state.doneObject_ = true;
        if (!state.variable_) {
            state.variable_ = state.value;
        }
        return new S8Interpreter.State(node['right'], state.scope);
    }
    if (!state.isLoop) {
        // First iteration.
        state.isLoop = true;
        state.object_ = state.value;
        state.visited_ = Object.create(null);
    }
    // Third, find the property name for this iteration.
    if (state.name_ === undefined) {
        gotPropName: while (true) {
            if (state.object_ instanceof S8Interpreter.Object) {
                if (!state.props_) {
                    state.props_ = Object.getOwnPropertyNames(state.object_.properties);
                }
                while (true) {
                    var prop = state.props_.shift();
                    if (prop === undefined) {
                        break;  // Reached end of this object's properties.
                    }
                    if (!Object.prototype.hasOwnProperty.call(state.object_.properties,
                        prop)) {
                        continue;  // Property has been deleted in the loop.
                    }
                    if (state.visited_[prop]) {
                        continue;  // Already seen this property on a child.
                    }
                    state.visited_[prop] = true;
                    if (!Object.prototype.propertyIsEnumerable.call(
                        state.object_.properties, prop)) {
                        continue;  // Skip non-enumerable property.
                    }
                    state.name_ = prop;
                    break gotPropName;
                }
            } else if (state.object_ !== null && state.object_ !== undefined) {
                // Primitive value (other than null or undefined).
                if (!state.props_) {
                    state.props_ = Object.getOwnPropertyNames(state.object_);
                }
                while (true) {
                    var prop = state.props_.shift();
                    if (prop === undefined) {
                        break;  // Reached end of this value's properties.
                    }
                    state.visited_[prop] = true;
                    if (!Object.prototype.propertyIsEnumerable.call(
                        state.object_, prop)) {
                        continue;  // Skip non-enumerable property.
                    }
                    state.name_ = prop;
                    break gotPropName;
                }
            }
            state.object_ = this.getPrototype(state.object_);
            state.props_ = null;
            if (state.object_ === null) {
                // Done, exit loop.
                stack.pop();
                return;
            }
        }
    }
    // Fourth, find the variable
    if (!state.doneVariable_) {
        state.doneVariable_ = true;
        const left = node['left'];
        if (left['type'] === 'VariableDeclaration') {
            // Inline variable declaration: for (var x in y)
            state.variable_ =
                [S8Interpreter.SCOPE_REFERENCE, left['declarations'][0]['id']['name']];
        } else {
            // Arbitrary left side: for (foo().bar in y)
            state.variable_ = null;
            const nextState = new S8Interpreter.State(left, state.scope);
            nextState.components = true;
            return nextState;
        }
    }
    if (!state.variable_) {
        state.variable_ = state.value;
    }
    // Fifth, set the variable.
    if (!state.doneSetter_) {
        state.doneSetter_ = true;
        const value = state.name_;
        const setter = this.setValue(state.variable_, value);
        if (setter) {
            return this.createSetter_(setter, state.variable_, value);
        }
    }
    // Next step will be step three.
    state.name_ = undefined;
    // Reevaluate the variable since it could be a setter on the global object.
    state.doneVariable_ = false;
    state.doneSetter_ = false;
    // Sixth and finally, execute the body if there was one.  this.
    if (node['body']) {
        return new S8Interpreter.State(node['body'], state.scope);
    }
};

S8Interpreter.prototype['stepForStatement'] = function(stack, state, node) {
    const mode = state.mode_ || 0;
    if (mode === 0) {
        state.mode_ = 1;
        if (node['init']) {
            return new S8Interpreter.State(node['init'], state.scope);
        }
    } else if (mode === 1) {
        state.mode_ = 2;
        if (node['test']) {
            return new S8Interpreter.State(node['test'], state.scope);
        }
    } else if (mode === 2) {
        state.mode_ = 3;
        if (node['test'] && !state.value) {
            // Done, exit loop.
            stack.pop();
        } else {  // Execute the body.
            state.isLoop = true;
            return new S8Interpreter.State(node['body'], state.scope);
        }
    } else if (mode === 3) {
        state.mode_ = 1;
        if (node['update']) {
            return new S8Interpreter.State(node['update'], state.scope);
        }
    }
};

S8Interpreter.prototype['stepFunctionDeclaration'] =
    function(stack, state, node) {
        // This was found and handled when the scope was populated.
        stack.pop();
    };

S8Interpreter.prototype['stepFunctionExpression'] = function(stack, state, node) {
    stack.pop();
    stack[stack.length - 1].value = this.createFunction(node, state.scope);
};

S8Interpreter.prototype['stepIdentifier'] = function(stack, state, node) {
    stack.pop();
    if (state.components) {
        stack[stack.length - 1].value = [S8Interpreter.SCOPE_REFERENCE, node['name']];
        return;
    }
    const value = this.getValueFromScope(node['name']);
    // An identifier could be a getter if it's a property on the global object.
    if (this.getterStep_) {
        // Call the getter function.
        let scope = state.scope;
        while (!this.hasProperty(scope, node['name'])) {
            scope = scope.parentScope;
        }
        const func = /** @type {!S8Interpreter.Object} */ (value);
        return this.createGetter_(func, this.globalObject);
    }
    stack[stack.length - 1].value = value;
};

S8Interpreter.prototype['stepIfStatement'] =
    S8Interpreter.prototype['stepConditionalExpression'];

S8Interpreter.prototype['stepLabeledStatement'] = function(stack, state, node) {
    // No need to hit this node again on the way back up the stack.
    stack.pop();
    // Note that a statement might have multiple labels.
    const labels = state.labels || [];
    labels.push(node['label']['name']);
    const nextState = new S8Interpreter.State(node['body'], state.scope);
    nextState.labels = labels;
    return nextState;
};

S8Interpreter.prototype['stepLiteral'] = function(stack, state, node) {
    stack.pop();
    let value = node['value'];
    if (value instanceof RegExp) {
        const pseudoRegexp = this.createObjectProto(this.REGEXP_PROTO);
        this.populateRegExp(pseudoRegexp, value);
        value = pseudoRegexp;
    }
    stack[stack.length - 1].value = value;
};

S8Interpreter.prototype['stepLogicalExpression'] = function(stack, state, node) {
    if (node['operator'] !== '&&' && node['operator'] !== '||') {
        throw SyntaxError('Unknown logical operator: ' + node['operator']);
    }
    if (!state.doneLeft_) {
        state.doneLeft_ = true;
        return new S8Interpreter.State(node['left'], state.scope);
    }
    if (!state.doneRight_) {
        if ((node['operator'] === '&&' && !state.value) ||
            (node['operator'] === '||' && state.value)) {
            // Shortcut evaluation.
            stack.pop();
            stack[stack.length - 1].value = state.value;
        } else {
            state.doneRight_ = true;
            return new S8Interpreter.State(node['right'], state.scope);
        }
    } else {
        stack.pop();
        stack[stack.length - 1].value = state.value;
    }
};

S8Interpreter.prototype['stepMemberExpression'] = function(stack, state, node) {
    if (!state.doneObject_) {
        state.doneObject_ = true;
        return new S8Interpreter.State(node['object'], state.scope);
    }
    let propName;
    if (!node['computed']) {
        state.object_ = state.value;
        // obj.foo -- Just access `foo` directly.
        propName = node['property']['name'];
    } else if (!state.doneProperty_) {
        state.object_ = state.value;
        // obj[foo] -- Compute value of `foo`.
        state.doneProperty_ = true;
        return new S8Interpreter.State(node['property'], state.scope);
    } else {
        propName = state.value;
    }
    stack.pop();
    if (state.components) {
        stack[stack.length - 1].value = [state.object_, propName];
    } else {
        const value = this.getProperty(state.object_, propName);
        if (this.getterStep_) {
            // Call the getter function.
            const func = /** @type {!S8Interpreter.Object} */ (value);
            return this.createGetter_(func, state.object_);
        }
        stack[stack.length - 1].value = value;
    }
};

S8Interpreter.prototype['stepNewExpression'] =
    S8Interpreter.prototype['stepCallExpression'];

S8Interpreter.prototype['stepObjectExpression'] = function(stack, state, node) {
    let n = state.n_ || 0;
    let property = node['properties'][n];
    if (!state.object_) {
        // First execution.
        state.object_ = this.createObjectProto(this.OBJECT_PROTO);
        state.properties_ = Object.create(null);
    } else {
        // Determine property name.
        var key = property['key'];
        if (key['type'] === 'Identifier') {
            var propName = key['name'];
        } else if (key['type'] === 'Literal') {
            var propName = key['value'];
        } else {
            throw SyntaxError('Unknown object structure: ' + key['type']);
        }
        // Set the property computed in the previous execution.
        if (!state.properties_[propName]) {
            // Create temp object to collect value, getter, and/or setter.
            state.properties_[propName] = {};
        }
        state.properties_[propName][property['kind']] = state.value;
        state.n_ = ++n;
        property = node['properties'][n];
    }
    if (property) {
        return new S8Interpreter.State(property['value'], state.scope);
    }
    for (var key in state.properties_) {
        const kinds = state.properties_[key];
        if ('get' in kinds || 'set' in kinds) {
            // Set a property with a getter or setter.
            const descriptor = {
                configurable: true,
                enumerable: true,
                get: kinds['get'],
                set: kinds['set'],
            };
            this.setProperty(state.object_, key, S8Interpreter.VALUE_IN_DESCRIPTOR,
                descriptor);
        } else {
            // Set a normal property with a value.
            this.setProperty(state.object_, key, kinds['init']);
        }
    }
    stack.pop();
    stack[stack.length - 1].value = state.object_;
};

S8Interpreter.prototype['stepProgram'] = function(stack, state, node) {
    const expression = node['body'].shift();
    if (expression) {
        state.done = false;
        return new S8Interpreter.State(expression, state.scope);
    }
    state.done = true;
    // Don't pop the stateStack.
    // Leave the root scope on the tree in case the program is appended to.
};

S8Interpreter.prototype['stepReturnStatement'] = function(stack, state, node) {
    if (node['argument'] && !state.done_) {
        state.done_ = true;
        return new S8Interpreter.State(node['argument'], state.scope);
    }
    this.unwind(S8Interpreter.Completion.RETURN, state.value, undefined);
};

S8Interpreter.prototype['stepSequenceExpression'] = function(stack, state, node) {
    const n = state.n_ || 0;
    const expression = node['expressions'][n];
    if (expression) {
        state.n_ = n + 1;
        return new S8Interpreter.State(expression, state.scope);
    }
    stack.pop();
    stack[stack.length - 1].value = state.value;
};

S8Interpreter.prototype['stepSwitchStatement'] = function(stack, state, node) {
    if (!state.test_) {
        state.test_ = 1;
        return new S8Interpreter.State(node['discriminant'], state.scope);
    }
    if (state.test_ === 1) {
        state.test_ = 2;
        // Preserve switch value between case tests.
        state.switchValue_ = state.value;
        state.defaultCase_ = -1;
    }

    while (true) {
        const index = state.index_ || 0;
        const switchCase = node['cases'][index];
        if (!state.matched_ && switchCase && !switchCase['test']) {
            // Test on the default case is null.
            // Bypass (but store) the default case, and get back to it later.
            state.defaultCase_ = index;
            state.index_ = index + 1;
            continue;
        }
        if (!switchCase && !state.matched_ && state.defaultCase_ !== -1) {
            // Ran through all cases, no match.  Jump to the default.
            state.matched_ = true;
            state.index_ = state.defaultCase_;
            continue;
        }
        if (switchCase) {
            if (!state.matched_ && !state.tested_ && switchCase['test']) {
                state.tested_ = true;
                return new S8Interpreter.State(switchCase['test'], state.scope);
            }
            if (state.matched_ || state.value === state.switchValue_) {
                state.matched_ = true;
                const n = state.n_ || 0;
                if (switchCase['consequent'][n]) {
                    state.isSwitch = true;
                    state.n_ = n + 1;
                    return new S8Interpreter.State(switchCase['consequent'][n],
                        state.scope);
                }
            }
            // Move on to next case.
            state.tested_ = false;
            state.n_ = 0;
            state.index_ = index + 1;
        } else {
            stack.pop();
            return;
        }
    }
};

S8Interpreter.prototype['stepThisExpression'] = function(stack) {
    stack.pop();
    stack[stack.length - 1].value = this.getValueFromScope('this');
};

S8Interpreter.prototype['stepThrowStatement'] = function(stack, state, node) {
    if (!state.done_) {
        state.done_ = true;
        return new S8Interpreter.State(node['argument'], state.scope);
    } else {
        this.throwException(state.value);
    }
};

S8Interpreter.prototype['stepTryStatement'] = function(stack, state, node) {
    if (!state.doneBlock_) {
        state.doneBlock_ = true;
        return new S8Interpreter.State(node['block'], state.scope);
    }
    if (state.cv && state.cv.type === S8Interpreter.Completion.THROW &&
        !state.doneHandler_ && node['handler']) {
        state.doneHandler_ = true;
        const nextState = new S8Interpreter.State(node['handler'], state.scope);
        nextState.throwValue = state.cv.value;
        state.cv = undefined;  // This error has been handled, don't rethrow.
        return nextState;
    }
    if (!state.doneFinalizer_ && node['finalizer']) {
        state.doneFinalizer_ = true;
        return new S8Interpreter.State(node['finalizer'], state.scope);
    }
    stack.pop();
    if (state.cv) {
        // There was no catch handler, or the catch/finally threw an error.
        // Throw the error up to a higher try.
        this.unwind(state.cv.type, state.cv.value, state.cv.label);
    }
};

S8Interpreter.prototype['stepUnaryExpression'] = function(stack, state, node) {
    if (!state.done_) {
        state.done_ = true;
        const nextState = new S8Interpreter.State(node['argument'], state.scope);
        nextState.components = node['operator'] === 'delete';
        return nextState;
    }
    stack.pop();
    let value = state.value;
    if (node['operator'] === '-') {
        value = -value;
    } else if (node['operator'] === '+') {
        value = +value;
    } else if (node['operator'] === '!') {
        value = !value;
    } else if (node['operator'] === '~') {
        value = ~value;
    } else if (node['operator'] === 'delete') {
        let result = true;
        // If value is not an array, then it is a primitive, or some other value.
        // If so, skip the delete and return true.
        if (Array.isArray(value)) {
            let obj = value[0];
            if (obj === S8Interpreter.SCOPE_REFERENCE) {
                // `delete foo;` is the same as `delete window.foo;`.
                obj = state.scope;
            }
            const name = String(value[1]);
            try {
                delete obj.properties[name];
            } catch (e) {
                if (state.scope.strict) {
                    this.throwException(this.TYPE_ERROR, 'Cannot delete property \'' +
                        name + '\' of \'' + obj + '\'');
                } else {
                    result = false;
                }
            }
        }
        value = result;
    } else if (node['operator'] === 'typeof') {
        value = (value && value.class === 'Function') ? 'function' : typeof value;
    } else if (node['operator'] === 'void') {
        value = undefined;
    } else {
        throw SyntaxError('Unknown unary operator: ' + node['operator']);
    }
    stack[stack.length - 1].value = value;
};

S8Interpreter.prototype['stepUpdateExpression'] = function(stack, state, node) {
    if (!state.doneLeft_) {
        state.doneLeft_ = true;
        const nextState = new S8Interpreter.State(node['argument'], state.scope);
        nextState.components = true;
        return nextState;
    }
    if (!state.leftSide_) {
        state.leftSide_ = state.value;
    }
    if (state.doneGetter_) {
        state.leftValue_ = state.value;
    }
    if (!state.doneGetter_) {
        const leftValue = this.getValue(state.leftSide_);
        state.leftValue_ = leftValue;
        if (this.getterStep_) {
            // Call the getter function.
            state.doneGetter_ = true;
            const func = /** @type {!S8Interpreter.Object} */ (leftValue);
            return this.createGetter_(func, state.leftSide_);
        }
    }
    if (state.doneSetter_) {
        // Return if setter function.
        // Setter method on property has completed.
        // Ignore its return value, and use the original set value instead.
        stack.pop();
        stack[stack.length - 1].value = state.setterValue_;
        return;
    }
    const leftValue = Number(state.leftValue_);
    let changeValue;
    if (node['operator'] === '++') {
        changeValue = leftValue + 1;
    } else if (node['operator'] === '--') {
        changeValue = leftValue - 1;
    } else {
        throw SyntaxError('Unknown update expression: ' + node['operator']);
    }
    const returnValue = node['prefix'] ? changeValue : leftValue;
    const setter = this.setValue(state.leftSide_, changeValue);
    if (setter) {
        state.doneSetter_ = true;
        state.setterValue_ = returnValue;
        return this.createSetter_(setter, state.leftSide_, changeValue);
    }
    // Return if no setter function.
    stack.pop();
    stack[stack.length - 1].value = returnValue;
};

S8Interpreter.prototype['stepVariableDeclaration'] = function(stack, state, node) {
    const declarations = node['declarations'];
    let n = state.n_ || 0;
    let declarationNode = declarations[n];
    if (state.init_ && declarationNode) {
        // This setValue call never needs to deal with calling a setter function.
        // Note that this is setting the init value, not defining the variable.
        // Variable definition is done when scope is populated.
        this.setValueToScope(declarationNode['id']['name'], state.value);
        state.init_ = false;
        declarationNode = declarations[++n];
    }
    while (declarationNode) {
        // Skip any declarations that are not initialized.  They have already
        // been defined as undefined in populateScope_.
        if (declarationNode['init']) {
            state.n_ = n;
            state.init_ = true;
            return new S8Interpreter.State(declarationNode['init'], state.scope);
        }
        declarationNode = declarations[++n];
    }
    stack.pop();
};

S8Interpreter.prototype['stepWithStatement'] = function(stack, state, node) {
    if (!state.doneObject_) {
        state.doneObject_ = true;
        return new S8Interpreter.State(node['object'], state.scope);
    } else if (!state.doneBody_) {
        state.doneBody_ = true;
        const scope = this.createSpecialScope(state.scope, state.value);
        return new S8Interpreter.State(node['body'], scope);
    } else {
        stack.pop();
    }
};

S8Interpreter.prototype['stepWhileStatement'] =
    S8Interpreter.prototype['stepDoWhileStatement'];

// Preserve top-level API functions from being pruned/renamed by JS compilers.
// Add others as needed.
// The global object (`window` in a browser, `global` in node.js) is `this`.

// this['Interpreter'] = Interpreter;

S8Interpreter.prototype['step'] = S8Interpreter.prototype.step;
S8Interpreter.prototype['run'] = S8Interpreter.prototype.run;
S8Interpreter.prototype['appendCode'] = S8Interpreter.prototype.appendCode;
S8Interpreter.prototype['createObject'] = S8Interpreter.prototype.createObject;
S8Interpreter.prototype['createObjectProto'] =
    S8Interpreter.prototype.createObjectProto;
S8Interpreter.prototype['createAsyncFunction'] =
    S8Interpreter.prototype.createAsyncFunction;
S8Interpreter.prototype['createNativeFunction'] =
    S8Interpreter.prototype.createNativeFunction;
S8Interpreter.prototype['getProperty'] = S8Interpreter.prototype.getProperty;
S8Interpreter.prototype['setProperty'] = S8Interpreter.prototype.setProperty;
S8Interpreter.prototype['nativeToPseudo'] = S8Interpreter.prototype.nativeToPseudo;
S8Interpreter.prototype['pseudoToNative'] = S8Interpreter.prototype.pseudoToNative;

export { S8Interpreter };
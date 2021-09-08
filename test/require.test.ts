import {Interpreter, InterpreterObject} from "../src";

let res = '';

jest.useFakeTimers();

const initFunction = (interpreter: Interpreter, scope: InterpreterObject) => {
    interpreter.setProperty(
        scope,
        'require',
        interpreter.createNativeFunction((packageName: string) => {
            switch (packageName) {
                case 'doer':
                    return interpreter.createNativeFunction(() => {
                        return interpreter.createNativeFunction(() => {
                                res += 'bla';
                            }
                        );
                    });
                case 'get':
                    return interpreter.createNativeFunction(() => {
                        return interpreter.nativeToPseudo('hi');
                    });
                case 'log':
                    return interpreter.createNativeFunction((msg: any) => {
                        res += msg;
                    });
                case 'defer':
                    return interpreter.createNativeFunction((f: any) => {
                        setTimeout(() => {
                            interpreter.queueFunction(f, undefined);
                            interpreter.run();
                        }, 100);
                    });
            }
        }),
    );
};

beforeEach(() => {
    res = '';
});

test('test doer', () => {
    new Interpreter(
        'var doer = require("doer");doer()();',
        initFunction
    ).runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
            expect(res).toBe('bla');
        },
    );
});

test('test defer', () => {
    new Interpreter(
        `
var doer = require("doer");
var get = require("get");
var defer = require("defer");
var log = require("log");
defer(function(){
    defer(function(){
        log(get());
        doer()();
    });
});
        `,
        initFunction
    ).runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
            expect(res).toBe('');
        },
    );
    jest.runAllTimers();
    expect(res).toBe('hibla');
});


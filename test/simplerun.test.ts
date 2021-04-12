import {Interpreter, InterpreterObject} from "../src";

const parentObj = {
    val: 0,
    str: '',
}

const func = (str: string) => {
    parentObj.str = str;
}

let objFromNative = {};

const initFunction = (interpreter: Interpreter, scope: InterpreterObject) => {
        interpreter.setProperty(
            scope,
            "parentObj",
            interpreter.nativeToPseudo(parentObj),
        );
        interpreter.setProperty(
            scope,
            'setStr',
            interpreter.nativeToPseudo((msg: string) => {
                func(msg);
            }),
        );
        interpreter.setProperty(
            scope,
            'getStr',
            interpreter.nativeToPseudo(() => {
                return parentObj.str;
            }),
        );
        interpreter.setProperty(
            scope,
            'setVal',
            interpreter.nativeToPseudo((n: number) => {
                parentObj.val = n;
            }),
        );
        interpreter.setProperty(
            scope,
            'getVal',
            interpreter.nativeToPseudo(() => {
                return parentObj.val;
            }),
        );
        interpreter.setProperty(
            scope,
            'export',
            interpreter.createNativeFunction((obj: any) => {
                objFromNative = interpreter.pseudoToNative(obj);
            }),
        );
};

beforeEach(() => {
    parentObj.val = 0;
    parentObj.str = '';
    objFromNative = {};
});

test('simple run', () => {
    const int = new Interpreter('6 * 7');
    int.runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
        }
    );
    expect(int.value).toBe(42);
});

test('just failing', () => {
    new Interpreter(
        'throw "horrible err"; setVal(2);',
        initFunction
    ).runAll(
        (e) => {
            expect(parentObj.val).toBe(0);
            expect(e).toBe('horrible err');
        },
        () => {
            fail(`failed: it should not complete`);
        }
    );
});

test('set value directly', () => {
    new Interpreter(
        'setVal(2);setVal(getVal()+2);',
        initFunction
    ).runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
            expect(parentObj.val).toBe(4);
        }
    );
    expect(parentObj.val).toBe(4);
});

test('set value by native function', () => {
    new Interpreter(
        'setStr("a"); setStr(getStr() + "b")',
        initFunction
    ).runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
            expect(parentObj.str).toBe('ab');
        },
    );
});

test('export pseudo object', () => {
    new Interpreter(
        'var a = {str:"abc", n:4}; export(a);',
        initFunction
    ).runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
            expect(JSON.stringify(objFromNative)).toBe('{"str":"abc","n":4}');
        },
    );
});

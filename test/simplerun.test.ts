import {Interpreter} from "../src";

test('exposing var', () => {
    let res = 0;

    new Interpreter(
        'res = 2+2;',
        (interpreter, scope) => {
            interpreter.setProperty(
                scope,
                "res",
                res
            );
        }
    ).runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
            expect(res).toBe(4);
        }
    );
});

test('just failing', () => {
    let res = 0;

    new Interpreter(
        'throw "horrible err"; res = 2+2;',
        (interpreter, scope) => {
            interpreter.setProperty(
                scope,
                "res",
                res
            );
        }
    ).runAll(
        (e) => {
            expect(res).toBe(0);
            expect(e).toBe('horrible err');
        },
        () => {
            fail(`failed: it should not complete`);
        }
    );
});

test('exposing function', () => {
    let res = '';

    const func = (str: string) => {
        res = str;
    }
    new Interpreter(
        'func("a"); func(res + "b")',
        (interpreter, scope) => {
            interpreter.setProperty(
                scope,
                "res",
                res
            );
            interpreter.setProperty(
                scope,
                'func',
                interpreter.nativeToPseudo((msg: string) => {
                    func(msg);
                }),
            );
        }
    ).runAll(
        (e) => {
            fail(`failed with error: ${e}`);
        },
        () => {
            expect(res).toBe('ab');
        },
    );
});

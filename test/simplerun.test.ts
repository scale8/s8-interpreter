import {Interpreter} from "../src";

test('exposing var', () => {
    let res = 0;

    new Interpreter(
        'res = 2+2;',
        (interpreter, globalObject) => {
            interpreter.setProperty(
                globalObject,
                "res",
                res
            );
        }).runAll(
        (e) => {},
        () => {
            expect(res).toBe(4);
        },
    );
});

test('just failing', () => {
    let res = 0;

    new Interpreter(
        'throw "horrible err"; res = 2+2;',
        (interpreter, globalObject) => {
            interpreter.setProperty(
                globalObject,
                "res",
                res
            );
        }).runAll(
        (e) => {
            expect(res).toBe(0);
            expect(e).toBe('');
        },
        () => {},
    );
});

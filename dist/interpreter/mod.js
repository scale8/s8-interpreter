
/**
 * Converts from a native JavaScript object or value to a JS-Interpreter object.
 * Can handle JSON-style values, regular expressions, dates and functions.
 * Does NOT handle cycles.
 * @param {*} nativeObj The native JavaScript object to be converted.
 * @return {Mod.Value} The equivalent JS-Interpreter object.
 */
Mod.prototype.nativeToPseudo

/**
 * Converts from a JS-Interpreter object to native JavaScript object.
 * Can handle JSON-style values, regular expressions, and dates.
 * Does handle cycles.
 * @param {Mod.Value} pseudoObj The JS-Interpreter object to be
 * converted.
 * @param {Object=} opt_cycles Cycle detection (used in recursive calls).
 * @return {*} The equivalent native JavaScript object or value.
 */
Mod.prototype.pseudoToNative
/**
 * Converts from a native JavaScript array to a JS-Interpreter array.
 * Does handle non-numeric properties (like str.match's index prop).
 * Does NOT recurse into the array's contents.
 * @param {!Array} nativeArray The JavaScript array to be converted.
 * @return {!Mod.Object} The equivalent JS-Interpreter array.
 */
Mod.prototype.arrayNativeToPseudo
/**
 * Converts from a JS-Interpreter array to native JavaScript array.
 * Does handle non-numeric properties (like str.match's index prop).
 * Does NOT recurse into the array's contents.
 * @param {!Mod.Object} pseudoArray The JS-Interpreter array,
 *     or JS-Interpreter object pretending to be an array.
 * @return {!Array} The equivalent native JavaScript array.
 */
Mod.prototype.arrayPseudoToNative


/**
 * Fetch a property value from a data object.
 * @param {Mod.Value} obj Data object.
 * @param {Mod.Value} name Name of property.
 * @return {Mod.Value} Property value (may be undefined).
 */
Mod.prototype.getProperty

/**
 * Does the named property exist on a data object.
 * @param {!Mod.Object} obj Data object.
 * @param {Mod.Value} name Name of property.
 * @return {boolean} True if property exists.
 */
Mod.prototype.hasProperty

/**
 * Set a property value on a data object.
 * @param {Mod.Value} obj Data object.
 * @param {Mod.Value} name Name of property.
 * @param {Mod.Value} value New property value.
 *     Use Interpreter.VALUE_IN_DESCRIPTOR if value is handled by
 *     descriptor instead.
 * @param {Object=} opt_descriptor Optional descriptor object.
 * @return {!Mod.Object|undefined} Returns a setter function if one
 *     needs to be called, otherwise undefined.
 */
Mod.prototype.setProperty
/**
 * Convenience method for adding a native function as a non-enumerable property
 * onto an object's prototype.
 * @param {!Mod.Object} obj Data object.
 * @param {Mod.Value} name Name of property.
 * @param {!Function} wrapper Function object.
 */
Mod.prototype.setNativeFunctionPrototype
/**
 * Convenience method for adding an async function as a non-enumerable property
 * onto an object's prototype.
 * @param {!Mod.Object} obj Data object.
 * @param {Mod.Value} name Name of property.
 * @param {!Function} wrapper Function object.
 */
Mod.prototype.setAsyncFunctionPrototype



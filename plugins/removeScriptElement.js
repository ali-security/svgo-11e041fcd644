'use strict';

exports.type = 'perItem';

exports.active = false;

exports.description = 'removes <script> elements (disabled by default)';

/**
 * Namespaces that support executable <script> elements.
 *
 * @type {Array}
 */
var SCRIPT_NAMESPACES = [
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/1999/xhtml'
];

/**
 * Resolve the XML namespace a prefix is bound to for the given element.
 *
 * XML namespace scoping is ancestor-scoped: a prefix is bound by the nearest
 * xmlns:<prefix> declaration on the element itself or on one of its ancestors.
 * Walking ancestor-or-self is therefore equivalent to the prefix stack the
 * upstream visitor plugin keeps, which pushes a binding on element enter and
 * pops it on exit, so its namespaces[namespaces.length - 1] is by construction
 * that same nearest ancestor-or-self binding. The walk must start at the
 * element itself because an element may declare the very prefix it uses, as in
 * <foo:script xmlns:foo="http://www.w3.org/2000/svg">.
 *
 * The parent chain is intact while this runs: lib/svgo/plugins.js monkeys()
 * filters a parent out of its own parent's content before descending into that
 * parent's children, so every visited item still points at the ancestors it
 * was parsed with.
 *
 * @param {Object} item element to resolve the prefix for
 * @param {String} prefix namespace prefix
 * @return {String|Undefined} bound namespace, undefined if the prefix is unbound
 */
function resolveNamespace(item, prefix) {

    var name = 'xmlns:' + prefix;

    for (var elem = item; elem; elem = elem.parentNode) {
        if (elem.attrs && elem.attrs[name]) {
            return elem.attrs[name].value;
        }
    }

    return undefined;

}

/**
 * Remove <script>.
 *
 * The match is namespace-aware: a bare <script>, and any <prefix:script> whose
 * prefix is bound to the SVG or the XHTML namespace, are removed because all of
 * them execute. A prefix bound to any other namespace denotes a foreign element
 * that clients do not execute, so it is kept.
 *
 * https://www.w3.org/TR/SVG/script.html
 *
 * @param {Object} item current iteration item
 * @return {Boolean} if false, item will be filtered out
 *
 * @author Patrick Klingemann
 */
exports.fn = function(item) {

    // isElem() compares the qualified name, so it only matches bare <script>.
    if (item.isElem('script')) {
        return false;
    }

    if (item.prefix && item.local === 'script') {
        // An unbound prefix resolves to undefined and the element is kept. That
        // branch is unreachable in practice: the parser (sax in strict mode with
        // xmlns enabled) rejects an unbound prefix while parsing, so such an
        // element never reaches a plugin at all.
        return SCRIPT_NAMESPACES.indexOf(resolveNamespace(item, item.prefix)) === -1;
    }

    return true;

};

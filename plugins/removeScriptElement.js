'use strict';

exports.type = 'perItem';

exports.active = false;

exports.description = 'removes <script> elements (disabled by default)';

var SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Namespaces that support executable <script> elements.
 *
 * @type {Array}
 */
var SCRIPT_NAMESPACES = [
    SVG_NAMESPACE,
    'http://www.w3.org/1999/xhtml'
];

/**
 * Namespaces that support SVG <foreignObject> elements.
 *
 * @type {Array}
 */
var FOREIGN_OBJECT_NAMESPACES = [SVG_NAMESPACE];

/**
 * Attributes that can load or navigate to executable documents in HTML.
 *
 * @type {Array}
 */
var HTML_URL_ATTRS = ['action', 'data', 'formaction', 'href', 'src'];

/**
 * Schemes whose URL runs code directly.
 *
 * Written as a regular expression rather than as string literals because
 * jshint rejects a literal script URL (W107), which cannot be relaxed without
 * touching the shared lint configuration. The value it is tested against is
 * already left-trimmed and lowercased, so the match needs no flags.
 *
 * @type {RegExp}
 */
var EXECUTABLE_URL_SCHEMES = /^(?:javascript|vbscript):/;

/**
 * Media types a data: URL is executed as a document with.
 *
 * @type {Array}
 */
var EXECUTABLE_DATA_MEDIA_TYPES = [
    'application/xhtml+xml',
    'image/svg+xml',
    'text/html'
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
 * Determine if a URL is executed as a document by clients.
 *
 * javascript: and the legacy vbscript: scheme run code directly, and a data:
 * URL whose media type is an executable document type runs whatever markup it
 * carries. Leading whitespace is ignored and the value is compared case
 * insensitively, because clients strip and fold it the same way.
 *
 * @param {String} value attribute value
 * @return {Boolean}
 */
function isExecutableUrl(value) {

    var normalizedValue = String(value).replace(/^\s+/, '').toLowerCase();

    if (EXECUTABLE_URL_SCHEMES.test(normalizedValue)) {
        return true;
    }

    if (normalizedValue.indexOf('data:') !== 0) {
        return false;
    }

    var mediaTypeEnd = normalizedValue.slice(5).search(/[;,]/);

    if (mediaTypeEnd === -1) {
        return false;
    }

    var mediaType = normalizedValue.slice(5, mediaTypeEnd + 5).trim();

    return EXECUTABLE_DATA_MEDIA_TYPES.indexOf(mediaType) !== -1;

}

/**
 * Determine if an element is an SVG <foreignObject>.
 *
 * The match is namespace-aware the same way the <script> match is: a bare
 * <foreignObject>, and any <prefix:foreignObject> whose prefix is bound to the
 * SVG namespace, open an HTML sub-document. An element with the same local name
 * in an unrelated namespace is a foreign element that clients do not render as
 * HTML, so it gets no special treatment.
 *
 * @param {Object} elem element to test
 * @return {Boolean}
 */
function isForeignObject(elem) {

    // isElem() compares the qualified name, so it only matches a bare one.
    if (elem.isElem('foreignObject')) {
        return true;
    }

    return Boolean(elem.prefix) && elem.local === 'foreignObject' &&
        FOREIGN_OBJECT_NAMESPACES.indexOf(resolveNamespace(elem, elem.prefix)) !== -1;

}

/**
 * Determine if an item is, or is inside, an SVG <foreignObject>.
 *
 * The walk is ancestor-or-self because the sub-document starts at the
 * <foreignObject> element itself: the upstream visitor plugin enters that
 * element, raises its foreignObject depth, and only then sanitizes that very
 * element's attributes, so the element is already inside the sub-document when
 * its own attributes are processed. Including the item itself in the walk is
 * the per-item equivalent of that ordering.
 *
 * @param {Object} item current iteration item
 * @return {Boolean}
 */
function inForeignObject(item) {

    for (var elem = item; elem; elem = elem.parentNode) {
        if (isForeignObject(elem)) {
            return true;
        }
    }

    return false;

}

/**
 * Strip executable HTML from an element inside a <foreignObject>.
 *
 * Content of a <foreignObject> is HTML, so it carries the whole HTML attack
 * surface rather than just the SVG event attributes: any on* handler, the
 * srcdoc of an embedded document, and any HTML URL attribute pointing at an
 * executable URL. The elements themselves and every other attribute are kept,
 * so visual content survives untouched.
 *
 * The local name is derived from the qualified name, so an attribute stays
 * covered whichever prefix it is written with.
 *
 * @param {Object} item current iteration item
 */
function sanitizeForeignObject(item) {

    if (!item.attrs || !inForeignObject(item)) {
        return;
    }

    Object.keys(item.attrs).forEach(function(name) {

        var local = name.slice(name.lastIndexOf(':') + 1).toLowerCase();

        if (local.indexOf('on') === 0 ||
            local === 'srcdoc' ||
            (HTML_URL_ATTRS.indexOf(local) !== -1 &&
                isExecutableUrl(item.attrs[name].value))
        ) {
            item.removeAttr(name);
        }

    });

}

/**
 * Remove <script> and sanitize executable HTML inside <foreignObject>.
 *
 * The <script> match is namespace-aware: a bare <script>, and any
 * <prefix:script> whose prefix is bound to the SVG or the XHTML namespace, are
 * removed because all of them execute. A prefix bound to any other namespace
 * denotes a foreign element that clients do not execute, so it is kept.
 *
 * Whatever survives is then sanitized when it sits in an SVG <foreignObject>,
 * whose content is HTML and therefore executes through event attributes, srcdoc
 * and executable URLs as well. The elements and their visual content are
 * preserved.
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
        if (SCRIPT_NAMESPACES.indexOf(resolveNamespace(item, item.prefix)) !== -1) {
            return false;
        }
    }

    sanitizeForeignObject(item);

    return true;

};

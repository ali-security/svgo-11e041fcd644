'use strict';

/**
 * The traversal is bottom-up so that a subtree is always processed before the
 * element containing it is collapsed.
 *
 * Collapsing an executable <a> replaces it with its children and therefore
 * drops every xmlns: prefix that <a> declared. A top-down pass would unbind
 * such a prefix before the <prefix:script> it binds has been visited, and that
 * script would then resolve to no namespace at all and survive. Walking the
 * subtree first keeps every binding in place for as long as it is needed.
 *
 * The grouping in .svgo.yml is unaffected: this plugin sits between
 * removeStyleElement and a `full` plugin, both passes run in the same order as
 * before, and the plugin is disabled by default anyway.
 */
exports.type = 'perItemReverse';

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
 * Namespaces that support SVG <a> elements.
 *
 * @type {Array}
 */
var ANCHOR_NAMESPACES = [SVG_NAMESPACE];

/**
 * Attributes that can load or navigate to executable documents in HTML.
 *
 * @type {Array}
 */
var HTML_URL_ATTRS = ['action', 'data', 'formaction', 'href', 'src'];

/**
 * Characters clients drop from a URL before they parse it.
 *
 * Browsers remove ASCII tab, line feed and carriage return from anywhere in a
 * URL, so "java&#9;script:alert(1)" navigates exactly like "javascript:".
 * Removing them here too means they cannot be used to smuggle an executable
 * scheme past the comparison below.
 *
 * @type {RegExp}
 */
var URL_IGNORED_CHARS = /[\t\n\r]/g;

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
 * never rewrites parentNode on the way down, and on the reverse pass it walks
 * a subtree to the bottom before the element containing it is visited, so an
 * item is always resolved against the ancestors it was parsed with — including
 * an <a> that is collapsed only after its whole subtree has been processed.
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
 * carries. The value is normalized the way clients normalize it before they
 * parse it: tabs and newlines are dropped from anywhere in the value, leading
 * whitespace is ignored, and the comparison is case insensitive.
 *
 * @param {String} value attribute value
 * @return {Boolean}
 */
function isExecutableUrl(value) {

    var normalizedValue = String(value)
            .replace(URL_IGNORED_CHARS, '')
            .replace(/^\s+/, '')
            .toLowerCase();

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
 * Determine if an element is an SVG <a>.
 *
 * The match is namespace-aware the same way the <script> and the
 * <foreignObject> matches are: a bare <a>, and any <prefix:a> whose prefix is
 * bound to the SVG namespace, are links clients navigate. An element with the
 * same local name in an unrelated namespace is a foreign element that carries
 * no link semantics, so it is left alone.
 *
 * @param {Object} elem element to test
 * @return {Boolean}
 */
function isAnchor(elem) {

    // isElem() compares the qualified name, so it only matches a bare one.
    if (elem.isElem('a')) {
        return true;
    }

    return Boolean(elem.prefix) && elem.local === 'a' &&
        ANCHOR_NAMESPACES.indexOf(resolveNamespace(elem, elem.prefix)) !== -1;

}

/**
 * Determine if an element links to an executable URL.
 *
 * A link target is written either as a plain href or as a prefixed one, most
 * commonly xlink:href, and clients honour both. Whichever prefix it carries,
 * the value decides: only a URL that executes makes the link dangerous.
 *
 * isExecutableUrl() coerces its argument, so an attribute without a value
 * cannot match.
 *
 * @param {Object} elem element to test
 * @return {Boolean}
 */
function hasExecutableLink(elem) {

    if (!elem.attrs) {
        return false;
    }

    return Object.keys(elem.attrs).some(function(name) {

        return (name === 'href' || name.slice(-5) === ':href') &&
            isExecutableUrl(elem.attrs[name].value);

    });

}

/**
 * Replace every executable link among an element's children with its content.
 *
 * Only an <a> whose own link executes is collapsed. An inert link such as
 * href="/safe" keeps navigating, so the element and its content are left
 * exactly as they were, and so is an <a> in an unrelated namespace.
 *
 * The collapse is driven from the parent, the way collapseGroups does it,
 * rather than from the anchor's own visit. lib/svgo/plugins.js monkeys()
 * rebuilds a node's content with Array.prototype.filter(), which fixes the
 * length up front but reads live indices, so splicing the array a plugin is
 * currently being filtered over silently drops siblings. The parent's content
 * has already been rebuilt by the time the parent itself is visited, so
 * mutating it here is safe. Iterating backwards keeps the indices of the
 * entries still to be visited valid across each in-place splice.
 *
 * @param {Object} item current iteration item
 */
function collapseExecutableAnchors(item) {

    if (item.isEmpty()) {
        return;
    }

    for (var i = item.content.length - 1; i >= 0; i--) {

        var child = item.content[i];

        if (isAnchor(child) && hasExecutableLink(child)) {
            // spliceContent() reparents the insertion, and an empty <a> simply
            // leaves nothing behind.
            item.spliceContent(i, 1, child.content || []);
        }

    }

}

/**
 * Remove <script>, sanitize executable HTML inside <foreignObject> and
 * collapse executable links.
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
 * Finally an <a> whose link executes is replaced by its own content: the link
 * target is what runs, so dropping the element removes the whole vector while
 * keeping everything the link was wrapped around visible.
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
    collapseExecutableAnchors(item);

    return true;

};

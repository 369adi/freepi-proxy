/**
 * Node half of the cleared-jobs plugin.
 *
 * The browser half owns every contribution; this entry exists so the package
 * appears as an ordinary Loader row, exactly like the shipped ui-jobs package.
 * @module dsh-client-ui-jobs-clean
 */

/** Loader-visible no-op body; the browser half carries the feature. */
function apply() {}

export { apply };

import canonicalize from "canonicalize";
/** RFC 8785 (JCS) canonical JSON string. */
export const jcs = (obj) => canonicalize(obj);

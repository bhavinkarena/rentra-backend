/**
 * Build a real `FormData` from an Express request.
 *
 * The ported actions take `(previousState, formData)` and read it with
 * `formData.get('email')` / `formData.getAll('photos')`, including file entries
 * they inspect via `.size` and `.arrayBuffer()`. Rather than rewrite eighty
 * functions to read `req.body`, we hand them exactly what they already expect.
 * Node 22 ships FormData/File natively, so these are the same objects the Next
 * runtime would have passed.
 *
 * Multer keeps uploads in memory (see the upload middleware), so the buffer is
 * already here and no temporary file is involved.
 */
export function toFormData(req) {
  const form = new FormData();

  for (const [key, value] of Object.entries(req.body ?? {})) {
    if (value === undefined || value === null) continue;
    /**
     * An array becomes repeated entries, which is what `getAll('amenity')`
     * reads. JSON clients send `{ amenity: ['pool','lawn'] }`; a multipart form
     * sends the field twice. Both land in the same shape here.
     */
    for (const item of Array.isArray(value) ? value : [value]) {
      form.append(key, serialise(item));
    }
  }

  for (const file of filesOf(req)) {
    form.append(
      file.fieldname,
      new File([file.buffer], file.originalname, { type: file.mimetype }),
    );
  }

  return form;
}

/**
 * Everything in a real multipart body arrives as a string, and the actions
 * parse accordingly (`Number(formData.get('guests'))`, zod coercions). A JSON
 * client sending a number or boolean must not take a different code path, so
 * scalars are stringified and objects are sent as JSON text.
 */
function serialise(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function filesOf(req) {
  if (Array.isArray(req.files)) return req.files;
  if (req.files) return Object.values(req.files).flat();
  return req.file ? [req.file] : [];
}

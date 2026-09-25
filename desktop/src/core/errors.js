// Python's ValueError: bad input a caller can report back (the API answers it with invalid_request).
class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

module.exports = { ValueError };

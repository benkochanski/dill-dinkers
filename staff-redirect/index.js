const STAFF_URL = 'https://script.google.com/macros/s/AKfycbxMLQsfjs0TowuFblO5gbsO0Ih91Dj2tQEvWzxUdwQGnJafCQiXcDkxhhIEOKwGGTGGcA/exec';

export default {
  async fetch(request) {
    return Response.redirect(STAFF_URL, 301);
  },
};

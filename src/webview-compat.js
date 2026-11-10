// Runtime compatibility for the supported Android WebView.
if (!Object.hasOwn) {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true,
    writable: true,
    value: function hasOwn(value, key) {
      return Object.prototype.hasOwnProperty.call(value, key)
    },
  })
}

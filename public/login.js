/* Login: kies wie je bent, daarna PIN. */
(function () {
  "use strict";
  var form = document.getElementById("user-form");
  if (!form) return;
  var hidden = document.getElementById("user");
  var pin = document.getElementById("pin");
  var err = document.getElementById("login-err");

  form.addEventListener("click", function (e) {
    var b = e.target;
    while (b && b !== form && !(b.classList && b.classList.contains("user-btn"))) b = b.parentNode;
    if (!b || b === form) return;
    e.preventDefault();
    hidden.value = b.getAttribute("data-user") || "";
    var all = form.querySelectorAll(".user-btn");
    for (var i = 0; i < all.length; i++) all[i].classList.remove("sel");
    b.classList.add("sel");
    if (pin) pin.focus();
  });

  form.addEventListener("submit", function (e) {
    if (hidden.value) return;
    e.preventDefault();
    if (err) {
      err.textContent = "Kies eerst wie je bent.";
      err.classList.remove("hidden");
    }
  });
})();

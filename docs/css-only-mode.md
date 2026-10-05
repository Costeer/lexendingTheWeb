# Automatic CSS-only mode

After loading and checking for open shadow roots, ordinary pages stop observing
DOM changes to reduce JavaScript work and improve performance. CSS automatically
styles new content without rescanning the page.

A small document-start detector wakes discovery when shadow components appear.

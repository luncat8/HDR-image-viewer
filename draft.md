
minimal image viewer

user open or drop or 1 or multiple folder or files, using file api

L R arrows and space to view next prev image whole page, keep aspect ratio

list of opened files and button to forget it (release handler and memory if keep).
open files menu on pointer near side of window or long press. close ou out or press outside.
near each file in list create button to copy path to clipboard

info to page title

events (next prev) should not form queue. ignore new till image ready.

### more features

separate html with webGPU based canvas viewer. f16.


link to each other html to top of menu, also link on main screen in case of webGPUI not supported.
in menu of webGPU file - add sliders to adj exposure, black, white points on histogram range.
so it will work as sdr-to-hdr range expander for view images

if possible detect already hdr images and:
- best to have separate controls: one for srd-to-hdr case, second to hdr-adj. to not apply unnecessary adj to already hdr images.
- if difficult to read hdr or adjust - then it is ok to skip adj of already hdr and ignore and fallback to <img> representation without canvas for them.


save adj sliders to local storage (debounce 1s) and load on startup

add button to copy all images as path list \n separator
add ability to paste list on empty page and in menu with button and ctrl-v
support relative path to index and web links


### typical bugs:
- drop cause 'no image found'
- use SRD canvas fail with HDR images. need or <img> tag this is better, or webGPU canvas 16bit
- multiple events like wheel cause it continue next after image loaded. should ignore until load and also debounce like 100ms

### code style

html, vanilla js, single tab indent, no external deps

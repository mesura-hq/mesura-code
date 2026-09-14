// Hermetic tests for ImageChord.js — the pure helpers behind the "copy image
// to clipboard" (ci) chord gate in WindowState. Like tst_keyregistry.qml, this
// imports ONLY the .js + QtQuick/QtTest, never the UI module, so it runs in CI
// where Symmetria.FileManager.UI is not installed.
//
// Locks down review finding #6: the conditional i-row (present only on images)
// and — the actual regression risk — that building it never mutates the shared
// static chord config.

import QtQuick
import QtTest
import "../../qml/Symmetria/FileManager/UI/services/ImageChord.js" as ImageChord

TestCase {
    name: "ImageChord"

    // Stand-in shaped exactly like WindowState._staticChordBindings["c"].
    function _staticCopyGroup() {
        return {
            label: "copy to clipboard",
            binds: [
                { key: "c", label: "File path", icon: "link" },
                { key: "f", label: "Filename", icon: "description" },
                { key: "n", label: "Name without extension", icon: "label" },
                { key: "d", label: "Directory path", icon: "folder" }
            ]
        };
    }

    // --- entryIsImage predicate -----------------------------------------------

    function test_entryIsImage_data() {
        return [
            { tag: "image entry",      entry: { isImage: true },  expect: true },
            { tag: "non-image entry",  entry: { isImage: false }, expect: false },
            { tag: "missing isImage",  entry: {},                 expect: false },
            { tag: "null",             entry: null,               expect: false },
            { tag: "undefined",        entry: undefined,          expect: false }
        ];
    }
    function test_entryIsImage(data) {
        compare(ImageChord.entryIsImage(data.entry), data.expect);
    }

    // --- copyGroupWithImageRow: conditional i row -----------------------------

    // (a) on an image, the i row is appended after the static binds
    function test_imageRowAppendedWhenImage() {
        var group = _staticCopyGroup();
        var out = ImageChord.copyGroupWithImageRow(group, true);
        compare(out.binds.length, 5, "expected the 4 static binds + the i row");
        var last = out.binds[out.binds.length - 1];
        compare(last.key, "i");
        compare(last.label, "Image to clipboard");
        verify(last.icon && last.icon.length > 0, "i row must carry an icon");
        compare(out.label, group.label, "group label preserved");
    }

    // (b) not an image → no i row (and no other binds invented)
    function test_noImageRowWhenNotImage() {
        var group = _staticCopyGroup();
        var out = ImageChord.copyGroupWithImageRow(group, false);
        compare(out.binds.length, 4);
        for (var i = 0; i < out.binds.length; i++)
            verify(out.binds[i].key !== "i", "no i row when not on an image");
    }

    // (c) NON-MUTATION — the regression the gate guards. WindowState shares one
    // static config across every chordBindings re-eval, so building the image
    // group must never grow the input. Exercise a true→false→true cursor cycle.
    function test_doesNotMutateStaticGroup() {
        var group = _staticCopyGroup();
        var originalLen = group.binds.length;
        ImageChord.copyGroupWithImageRow(group, true);
        ImageChord.copyGroupWithImageRow(group, false);
        ImageChord.copyGroupWithImageRow(group, true);
        compare(group.binds.length, originalLen,
                "static copy-group binds must not grow across re-evaluations");
    }

    // The not-an-image path returns the SAME object (cheap identity), the
    // image path returns a fresh one (so bindings see a new value).
    function test_returnIdentity() {
        var group = _staticCopyGroup();
        verify(ImageChord.copyGroupWithImageRow(group, false) === group,
               "non-image path returns the input untouched");
        verify(ImageChord.copyGroupWithImageRow(group, true) !== group,
               "image path returns a fresh group, not the shared static one");
    }
}

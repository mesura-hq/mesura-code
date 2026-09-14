import Symmetria.FileManager.UI

StyledText {
    property real fill
    property int grade: FmTheme.light ? 0 : -25

    font.family: FmTheme.font.family.material
    font.pointSize: FmTheme.font.size.lg
    font.variableAxes: ({
            FILL: fill.toFixed(1),
            GRAD: grade,
            opsz: fontInfo.pixelSize,
            wght: fontInfo.weight
        })
}

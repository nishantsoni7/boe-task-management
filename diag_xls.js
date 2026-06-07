const XLSX = require('xlsx');

// Script 1: Raw cell values and types
const wb = XLSX.readFile('C:\\Users\\Lenovo\\Desktop\\monthperformance07062026132218.xls', {
  raw: true,
  cellDates: false,
  cellNF: true,
  cellStyles: true
});

const ws = wb.Sheets[wb.SheetNames[0]];
const range = XLSX.utils.decode_range(ws['!ref']);
console.log('Rows:', range.e.r + 1, 'Cols:', range.e.c + 1);
console.log();

// xlrd ctype: 0=empty,1=text,2=number,3=date,4=bool,5=error,6=blank
// SheetJS types: n=number, s=string, b=boolean, e=error, z=stub/empty

function xlrdType(t) {
  const map = { n: 2, s: 1, b: 4, e: 5, z: 6 };
  return t !== undefined && map[t] !== undefined ? map[t] : 0;
}

for (let r = range.s.r; r <= range.e.r; r++) {
  const c0addr = XLSX.utils.encode_cell({r, c: 0});
  const c0 = ws[c0addr];
  const col0val = c0 ? c0.v : '';
  if (String(col0val).trim() === 'Empcode') {
    const c2addr = XLSX.utils.encode_cell({r, c: 2});
    const c7addr = XLSX.utils.encode_cell({r, c: 7});
    const cell_code = ws[c2addr];
    const cell_name = ws[c7addr];

    const codeVal = cell_code ? cell_code.v : undefined;
    const codeCtype = xlrdType(cell_code ? cell_code.t : undefined);
    const nameVal = cell_name ? cell_name.v : undefined;
    const nameCtype = xlrdType(cell_name ? cell_name.t : undefined);

    console.log('Row ' + r + ': col[0]=' + JSON.stringify(col0val));
    console.log('  col[2] raw value=' + JSON.stringify(codeVal) + ', type=' + codeCtype + ' (0=empty,1=text,2=number,3=date,4=bool,5=error,6=blank)');
    console.log('  col[7] raw value=' + JSON.stringify(nameVal) + ', type=' + nameCtype);
    console.log('  str(col2)=' + JSON.stringify(String(codeVal)));
    console.log('  SheetJS cell_code.t=' + (cell_code ? cell_code.t : 'undefined') + ', .w=' + (cell_code ? cell_code.w : 'undefined') + ', .v=' + (cell_code ? cell_code.v : 'undefined'));
    console.log();
  }
}

// Script 2: XF format info equivalent
console.log('--- XF / Format String equivalent ---');
console.log();

const wb2 = XLSX.readFile('C:\\Users\\Lenovo\\Desktop\\monthperformance07062026132218.xls', {
  raw: true,
  cellDates: false,
  cellNF: true,
  cellStyles: true
});

const ws2 = wb2.Sheets[wb2.SheetNames[0]];

for (let r = range.s.r; r <= range.e.r; r++) {
  const c0addr = XLSX.utils.encode_cell({r, c: 0});
  const c0 = ws2[c0addr];
  const col0val = c0 ? c0.v : '';
  if (String(col0val).trim() === 'Empcode') {
    const c2addr = XLSX.utils.encode_cell({r, c: 2});
    const cell = ws2[c2addr];
    console.log('Row ' + r + ': empcode cell value=' + JSON.stringify(cell ? cell.v : undefined) + ', ctype=' + xlrdType(cell ? cell.t : undefined));
    console.log('  SheetJS .t (type)=' + (cell ? cell.t : 'undefined'));
    console.log('  SheetJS .w (formatted text)=' + (cell ? cell.w : 'undefined'));
    console.log('  SheetJS .z (number format)=' + (cell ? cell.z : 'undefined'));
    console.log('  SheetJS .s (style)=' + JSON.stringify(cell ? cell.s : undefined));
    console.log();
  }
}

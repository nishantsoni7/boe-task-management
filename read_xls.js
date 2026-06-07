const XLSX = require('xlsx');
const wb = XLSX.readFile('C:/Users/Lenovo/Desktop/monthperformance07062026132218.xls', {raw: true, cellDates: false});
console.log('Sheet names:', wb.SheetNames);
for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];
  const ref = ws['!ref'] || 'A1';
  const range = XLSX.utils.decode_range(ref);
  console.log('\n=== Sheet: ' + sheetName + ' | Rows: ' + (range.e.r+1) + ' | Cols: ' + (range.e.c+1) + ' ===');
  for (let r = range.s.r; r <= Math.min(range.e.r, 79); r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({r: r, c: c});
      const cell = ws[cellAddr];
      row.push(cell !== undefined ? String(cell.v) : '');
    }
    const rStr = String(r).padStart(3, ' ');
    console.log('  Row ' + rStr + ': ' + JSON.stringify(row));
  }
}

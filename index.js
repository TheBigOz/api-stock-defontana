const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        // VOLVEMOS A LA CONFIGURACIÓN ESTABLE (headless: true)
        browser = await puppeteer.launch({
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process', // Ahorra memoria
                '--no-zygote',      // Ahorra memoria
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        // Tiempos generosos
        page.setDefaultNavigationTimeout(60000); 
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. LOGIN
        console.log('1. Entrando al Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('input[formcontrolname="email"]');
               // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('2. Login OK. Abriendo ERP...');

        // 2. ABRIR PESTAÑA ERP
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        await erpButton.click();
        await new Promise(r => setTimeout(r, 5000)); 

        // 3. RECUPERAR PESTAÑA
        const pages = await browser.pages();
        const erpPage = pages[pages.length - 1]; 

        if (!erpPage) throw new Error("No se pudo detectar la pestaña del ERP");

        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        console.log('3. Pestaña capturada. ESPERANDO 15 SEGUNDOS...');
        await new Promise(r => setTimeout(r, 15000));

        // 4. NAVEGACIÓN
        console.log('4. Buscando menú Inventario...');
        const xpathInventario = "//span[contains(text(), 'Inventario')]";
        try {
            await erpPage.waitForXPath(xpathInventario, { visible: true, timeout: 5000 });
            const [btnInv] = await erpPage.$x(xpathInventario);
            await erpPage.evaluate(el => el.click(), btnInv);
        } catch(e) { console.log('   (Inventario quizás ya estaba abierto)'); }

        await new Promise(r => setTimeout(r, 1000));

        console.log('5. Clickeando Artículos...');
        const xpathArticulos = "//span[contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(xpathArticulos, { visible: true });
        const [btnArt] = await erpPage.$x(xpathArticulos);
        await erpPage.evaluate(el => el.click(), btnArt);

        console.log('6. Esperando carga de módulo (10 seg)...');
        await new Promise(r => setTimeout(r, 10000)); 

        // 5. BÚSQUEDA DEL INPUT
        console.log('7. Escaneando frames...');
        
        let targetFrame = null;
        let foundSelector = null;
        const selectorPrincipal = 'input[formcontrolname="searchInputText"]';
        
        const allFrames = erpPage.frames();

        for (const frame of allFrames) {
            if (await frame.$(selectorPrincipal)) {
                console.log(`   > ¡EUREKA! Input encontrado en frame: ${frame.url()}`);
                targetFrame = frame;
                foundSelector = selectorPrincipal;
                break;
            }
        }

        if (!targetFrame) {
            // Backup placeholder
            for (const frame of allFrames) {
                if (await frame.$('input[placeholder*="escripción"]')) {
                    targetFrame = frame;
                    foundSelector = 'input[placeholder*="escripción"]';
                    break;
                }
            }
        }

        if (!targetFrame) throw new Error("No se encontró el input.");

        // ACCIÓN: Escribir SKU (MÉTODO 100% TECLADO)
        console.log(`8. Escribiendo SKU: ${skuLimpio}`);
        
        // A) Hacemos clic para poner el foco
        await targetFrame.click(foundSelector);
        await new Promise(r => setTimeout(r, 500));

        // B) Borramos usando TECLADO (Ctrl+A -> Backspace)
        // Esto Angular SÍ lo detecta, a diferencia de value=''
        await erpPage.keyboard.down('Control');
        await erpPage.keyboard.press('A');
        await erpPage.keyboard.up('Control');
        await erpPage.keyboard.press('Backspace');

        // C) Escribimos letra por letra (delay humano)
        await targetFrame.type(foundSelector, skuLimpio, { delay: 100 });
        
        // D) Esperamos un momento para que Angular procese
        await new Promise(r => setTimeout(r, 500));

        // E) Presionamos Enter
        console.log('   > Texto ingresado. Presionando Enter...');
        await erpPage.keyboard.press('Enter');

        // 6. RESULTADOS
        console.log('9. Esperando resultados...');
        
        // Damos tiempo a la tabla para refrescarse
        await new Promise(r => setTimeout(r, 4000));

        // Extracción
        const resultado = await targetFrame.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            const debugInfo = [];
            
            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';
                
                debugInfo.push(textoCodigo);

                // Comparamos (usamos includes para ser más flexibles)
                if (textoCodigo.includes(sku)) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        found: true,
                        data: {
                            codigo: textoCodigo,
                            descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                            stock: celdaStock ? celdaStock.innerText.trim() : '0',
                            precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                        }
                    };
                }
            }
            return { found: false, count: filas.length, seen: debugInfo };
        }, skuLimpio);

        console.log('Resultado obtenido:', resultado);

        if (resultado.found) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado.data });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                debug: {
                    filas_encontradas: resultado.count,
                    codigos_vistos: resultado.seen
                },
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR FATAL:', error);
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
